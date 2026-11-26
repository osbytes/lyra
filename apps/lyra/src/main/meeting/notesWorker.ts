/**
 * Local meeting-notes worker (utilityProcess): runs a small instruct model with
 * llama.cpp, constrained to the notes JSON schema so output always parses.
 */
import type { GbnfJsonObjectSchema, Llama, LlamaGrammar, LlamaModel } from 'node-llama-cpp'
import { z } from 'zod'
import { loadLlamaModule } from '../llamaModule'
import { fitText, promptTokens, titlePrompt, type TokenCounter } from './notesChunks'
import { NOTES_SYSTEM_PROMPTS, TitleSuggestion, TITLE_SYSTEM_PROMPT } from './notesFormat'
import { callSignal } from './notesJobs'
import { writeNotes } from './notesPipeline'
import { NotesWorkerRequest, type NotesWorkerResponse } from './notesProtocol'

const CONTEXT_SIZE = 8192
/** Notes for one section are short; the cap also stops a model that never closes its JSON. */
const NOTES_OUTPUT_TOKENS = 1536
const TITLE_OUTPUT_TOKENS = 64
/** The chat template's own tokens around the system prompt and the message. */
const TEMPLATE_TOKENS = 64
/** A 3B model on a slow CPU takes a few minutes on a full context; longer than this, it's stuck. */
const PROMPT_TIMEOUT_MS = 10 * 60_000
/** The model (~2.5 GB in memory) is freed after this long unused, so Whisper has room. */
const IDLE_UNLOAD_MS = 3 * 60_000

let llama: Llama | null = null
let loaded: { path: string; model: LlamaModel } | null = null

async function getModel(modelPath: string): Promise<{ llama: Llama; model: LlamaModel }> {
  const { getLlama } = await loadLlamaModule()
  llama ??= await getLlama()
  if (loaded?.path !== modelPath) {
    await loaded?.model.dispose()
    loaded = { path: modelPath, model: await llama.loadModel({ modelPath }) }
  }
  return { llama, model: loaded.model }
}

async function unload(): Promise<void> {
  const model = loaded?.model
  loaded = null
  await model?.dispose()
}

/**
 * The JSON Schema for a grammar, generated from the same zod schema the answer is parsed with.
 * node-llama-cpp types this parameter from literal schemas only; it checks the schema itself when
 * it builds the grammar, and the reply is parsed against the zod schema in notesLocal.ts.
 */
function grammarSchema(schema: z.ZodObject): GbnfJsonObjectSchema {
  return z.toJSONSchema(schema, { target: 'draft-07' }) as GbnfJsonObjectSchema
}

/** One prompt in a fresh chat, constrained by `grammar`. */
async function prompt(
  model: LlamaModel,
  options: { grammar: LlamaGrammar; system: string; text: string; maxTokens: number; signal: AbortSignal }
): Promise<unknown> {
  const { LlamaChatSession } = await loadLlamaModule()
  const context = await model.createContext({ contextSize: CONTEXT_SIZE })
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: options.system })
    const text = await session.prompt(options.text, {
      grammar: options.grammar,
      temperature: 0.2,
      maxTokens: options.maxTokens,
      signal: callSignal(options.signal, PROMPT_TIMEOUT_MS)
    })
    // The grammar guarantees JSON; the caller checks its shape with the zod schema.
    const value: unknown = JSON.parse(text)
    return value
  } finally {
    await context.dispose()
  }
}

type Work = Exclude<NotesWorkerRequest, { kind: 'cancel' } | { kind: 'release' }>

async function answer(request: Work, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<unknown> {
  signal.throwIfAborted()
  const { llama: runtime, model } = await getModel(request.modelPath)
  // Chunks are measured with the model's own tokenizer: a character count is ~4x off for
  // Chinese or Japanese, which would overflow the context.
  const count: TokenCounter = (text) => model.tokenize(text).length
  switch (request.kind) {
    case 'title': {
      const grammar = await runtime.createGrammarForJsonSchema(grammarSchema(TitleSuggestion))
      const room = CONTEXT_SIZE - TITLE_OUTPUT_TOKENS - count(TITLE_SYSTEM_PROMPT) - TEMPLATE_TOKENS
      const text = titlePrompt(fitText(request.text, room - count(titlePrompt('')), count))
      return prompt(model, { grammar, system: TITLE_SYSTEM_PROMPT, text, maxTokens: TITLE_OUTPUT_TOKENS, signal })
    }
    case 'notes': {
      // One grammar per answer shape (whole meeting, section, overview), built on first use.
      const grammars = new Map<z.ZodObject, LlamaGrammar>()
      const grammarFor = async (schema: z.ZodObject): Promise<LlamaGrammar> => {
        const known = grammars.get(schema)
        if (known) return known
        const grammar = await runtime.createGrammarForJsonSchema(grammarSchema(schema))
        grammars.set(schema, grammar)
        return grammar
      }
      return writeNotes({
        lines: request.lines,
        budget: CONTEXT_SIZE - NOTES_OUTPUT_TOKENS - promptTokens(NOTES_SYSTEM_PROMPTS, count) - TEMPLATE_TOKENS,
        count,
        signal,
        onProgress,
        ask: async (call) =>
          prompt(model, {
            grammar: await grammarFor(call.schema),
            system: call.system,
            text: call.prompt,
            maxTokens: NOTES_OUTPUT_TOKENS,
            signal
          })
      })
    }
  }
}

/** One request at a time: a title and notes asked together would otherwise load the model twice. */
let queue: Promise<unknown> = Promise.resolve()
let busy = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
const running = new Map<number, AbortController>()

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  busy += 1
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const run = queue.then(work)
  queue = run
    .catch(() => undefined)
    .finally(() => {
      busy -= 1
      if (busy === 0 && loaded) {
        idleTimer = setTimeout(() => {
          idleTimer = null
          if (busy === 0) void unload()
        }, IDLE_UNLOAD_MS)
      }
    })
  return run
}

function reply(response: NotesWorkerResponse): void {
  process.parentPort.postMessage(response)
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const parsed = NotesWorkerRequest.safeParse(event.data)
  if (!parsed.success) return
  const request = parsed.data
  switch (request.kind) {
    case 'cancel':
      running.get(request.id)?.abort(new Error('Cancelled'))
      return
    case 'release':
      void enqueue(unload)
      return
    case 'notes':
    case 'title': {
      const controller = new AbortController()
      running.set(request.id, controller)
      const onProgress = (done: number, total: number): void => {
        reply({ kind: 'progress', id: request.id, done, total })
      }
      enqueue(() => answer(request, controller.signal, onProgress))
        .then(
          (result) => {
            reply({ kind: 'result', id: request.id, result })
          },
          (error: unknown) => {
            reply({ kind: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) })
          }
        )
        .finally(() => running.delete(request.id))
      return
    }
  }
})

/**
 * Local meeting-notes worker (utilityProcess): runs a small instruct model with
 * llama.cpp, constrained to the notes JSON schema so output always parses.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as NodeLlamaCpp from 'node-llama-cpp'
import type { GbnfJsonObjectSchema, Llama, LlamaModel } from 'node-llama-cpp'
import { z } from 'zod'
import {
  MeetingNotes,
  NOTES_SYSTEM_PROMPT,
  PACKAGED_FLAG,
  TitleSuggestion,
  TITLE_SYSTEM_PROMPT
} from './notesFormat'

export type NotesWorkerRequest = {
  id: number
  modelPath: string
  /** Meeting notes, or a title suggestion. */
  task: 'notes' | 'title'
  /** Each prompt is answered independently, in a fresh chat. */
  prompts: string[]
}

export type NotesWorkerResponse =
  | { id: number; ok: true; results: unknown[] }
  | { id: number; ok: false; error: string }

const CONTEXT_SIZE = 8192

type LlamaModule = typeof NodeLlamaCpp

/**
 * Packaged builds ship node-llama-cpp as its own npm install in resources/llama
 * (see scripts/prepare-llama.cjs); in development it comes from node_modules.
 * It's ESM-only, so it's loaded with import() from this CommonJS bundle.
 */
let llamaModule: Promise<LlamaModule> | null = null
function loadLlamaModule(): Promise<LlamaModule> {
  if (!llamaModule) {
    const packaged = join(process.resourcesPath, 'llama', 'node_modules', 'node-llama-cpp', 'dist', 'index.js')
    llamaModule = process.argv.includes(PACKAGED_FLAG)
      ? (import(pathToFileURL(packaged).href) as Promise<LlamaModule>)
      : import('node-llama-cpp')
  }
  return llamaModule
}

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

/**
 * The JSON Schema for a grammar, generated from the same zod schema the answer is parsed with.
 * node-llama-cpp types this parameter from literal schemas only; it checks the schema itself when
 * it builds the grammar, and the reply is parsed against the zod schema in notesLocal.ts.
 */
function grammarSchema(schema: z.ZodObject): GbnfJsonObjectSchema {
  return z.toJSONSchema(schema, { target: 'draft-07' }) as GbnfJsonObjectSchema
}

async function answer(request: NotesWorkerRequest): Promise<unknown[]> {
  const { LlamaChatSession } = await loadLlamaModule()
  const { llama: runtime, model } = await getModel(request.modelPath)
  const title = request.task === 'title'
  const grammar = title
    ? await runtime.createGrammarForJsonSchema(grammarSchema(TitleSuggestion))
    : await runtime.createGrammarForJsonSchema(grammarSchema(MeetingNotes))
  const results: unknown[] = []
  for (const prompt of request.prompts) {
    const context = await model.createContext({ contextSize: CONTEXT_SIZE })
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: title ? TITLE_SYSTEM_PROMPT : NOTES_SYSTEM_PROMPT
      })
      const text = await session.prompt(prompt, { grammar, temperature: 0.2 })
      results.push(grammar.parse(text))
    } finally {
      await context.dispose()
    }
  }
  return results
}

/** One request at a time: a title and notes asked together would otherwise load the model twice. */
let queue: Promise<unknown> = Promise.resolve()

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const request = event.data as NotesWorkerRequest
  const run = queue.then(() => answer(request))
  queue = run.catch(() => undefined)
  run.then(
    (results) => {
      const response: NotesWorkerResponse = { id: request.id, ok: true, results }
      process.parentPort.postMessage(response)
    },
    (error: unknown) => {
      const response: NotesWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      process.parentPort.postMessage(response)
    }
  )
})

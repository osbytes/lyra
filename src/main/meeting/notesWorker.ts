/**
 * Local meeting-notes worker (utilityProcess): runs a small instruct model with
 * llama.cpp, constrained to the notes JSON schema so output always parses.
 */
import type { Llama, LlamaModel } from 'node-llama-cpp'
import { NOTES_SCHEMA, NOTES_SYSTEM_PROMPT } from './notesFormat'

export type NotesWorkerRequest = {
  id: number
  modelPath: string
  /** Each prompt is answered independently, in a fresh chat. */
  prompts: string[]
}

export type NotesWorkerResponse =
  | { id: number; ok: true; results: unknown[] }
  | { id: number; ok: false; error: string }

const CONTEXT_SIZE = 8192

let llama: Llama | null = null
let loaded: { path: string; model: LlamaModel } | null = null

async function getModel(modelPath: string): Promise<{ llama: Llama; model: LlamaModel }> {
  // node-llama-cpp is ESM-only; load it lazily from this CommonJS bundle.
  const { getLlama } = await import('node-llama-cpp')
  llama ??= await getLlama()
  if (loaded?.path !== modelPath) {
    await loaded?.model.dispose()
    loaded = { path: modelPath, model: await llama.loadModel({ modelPath }) }
  }
  return { llama, model: loaded.model }
}

async function answer(request: NotesWorkerRequest): Promise<unknown[]> {
  const { LlamaChatSession } = await import('node-llama-cpp')
  const { llama: runtime, model } = await getModel(request.modelPath)
  const grammar = await runtime.createGrammarForJsonSchema(NOTES_SCHEMA)
  const results: unknown[] = []
  for (const prompt of request.prompts) {
    const context = await model.createContext({ contextSize: CONTEXT_SIZE })
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: NOTES_SYSTEM_PROMPT
      })
      const text = await session.prompt(prompt, { grammar, temperature: 0.2 })
      results.push(grammar.parse(text))
    } finally {
      await context.dispose()
    }
  }
  return results
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const request = event.data as NotesWorkerRequest
  answer(request).then(
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

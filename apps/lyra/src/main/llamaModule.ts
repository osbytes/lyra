import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as NodeLlamaCpp from 'node-llama-cpp'
import { z } from 'zod'
import { PACKAGED_FLAG } from './meeting/notesFormat'

export type LlamaModule = typeof NodeLlamaCpp

const LoadedModule = z.custom<LlamaModule>(
  (value) => typeof value === 'object' && value !== null && 'getLlama' in value && typeof value.getLlama === 'function',
  'node-llama-cpp did not load'
)

let loading: Promise<LlamaModule> | null = null

/**
 * node-llama-cpp for a worker process. Packaged builds ship it as its own npm install in
 * resources/llama (scripts/prepare-llama.cjs); in development it comes from node_modules. It's
 * ESM-only, so it's loaded with import() from these CommonJS bundles.
 */
export function loadLlamaModule(): Promise<LlamaModule> {
  if (!loading) {
    const packaged = join(process.resourcesPath, 'llama', 'node_modules', 'node-llama-cpp', 'dist', 'index.js')
    const imported: Promise<unknown> = process.argv.includes(PACKAGED_FLAG)
      ? import(pathToFileURL(packaged).href)
      : import('node-llama-cpp')
    loading = imported.then((module) => LoadedModule.parse(module))
  }
  return loading
}

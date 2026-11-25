import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { PROVIDERS, type ProviderId } from '../../shared/ai'
import { isLoopbackUrl, type Settings } from '../../shared/settings'
import type { Config } from '../config'
import { estimateTokens } from './notesChunks'
import { NOTES_SYSTEM_PROMPT } from './notesFormat'
import { createModelNotesWriter, type NotesWriter } from './notesWriter'
import { createOllamaNotesWriter, isOllama, type Fetch } from './ollama'

export { detectLocalServers, listLocalModels, type LocalServer } from './ollama'
export { testNotesWriter, type WriterTest } from './notesWriter'

/** What choosing a writer needs; index.ts passes the real ones, tests pass their own. */
export type WriterDeps = {
  settings: () => Settings
  /** The key for a provider: saved in Settings, else from the environment. */
  apiKey: (provider: ProviderId) => Promise<string | null>
  baseUrls: Config['baseUrls']
  local: NotesWriter
  /** For tests; the real `fetch` otherwise (used only to ask a configured server what it is). */
  fetch?: Fetch
}

/**
 * An OpenAI-compatible server says nothing about its context size, and the common local ones
 * default small (LM Studio and Ollama's `/v1`: 4096 tokens) and cut a long prompt silently. So
 * each call assumes 4096: room for the answer and the prompt, the rest for transcript.
 */
const COMPATIBLE_CONTEXT = 4_096
const COMPATIBLE_OUTPUT = 1_024
const COMPATIBLE_BUDGET = COMPATIBLE_CONTEXT - COMPATIBLE_OUTPUT - estimateTokens(NOTES_SYSTEM_PROMPT) - 64
/** A local server on a CPU is slow; this only catches one that hung. */
const COMPATIBLE_CALL_TIMEOUT_MS = 10 * 60_000

type ModelChoice = { provider: ProviderId; model: string; apiKey: string | null; baseUrl: string | null }

/** The one place a provider SDK is constructed. Everything else sees an AI SDK `LanguageModel`. */
export function languageModel({ provider, model, apiKey, baseUrl }: ModelChoice): LanguageModel {
  const key = apiKey === null ? {} : { apiKey }
  const base = baseUrl === null ? {} : { baseURL: baseUrl }
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ ...key, ...base })(model)
    case 'openai':
      return createOpenAI({ ...key, ...base })(model)
    case 'google':
      return createGoogleGenerativeAI({ ...key, ...base })(model)
    case 'openai-compatible':
      if (baseUrl === null) throw new Error('Add the server address in Settings → Sessions.')
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: baseUrl,
        ...key,
        supportsStructuredOutputs: true
      })(model)
  }
}

/**
 * The writer the user chose in Settings, or null when summaries are off. A cloud choice that
 * can't run yet (no key, no model, no server address) throws a message saying what to fill in.
 */
export async function chooseWriter(deps: WriterDeps): Promise<NotesWriter | null> {
  const settings = deps.settings()
  switch (settings.notesEngine) {
    case 'off':
      return null
    case 'local':
      return deps.local
    case 'cloud': {
      const provider = settings.cloudProvider
      const info = PROVIDERS[provider]
      const model = settings.cloudModel ?? info.defaultModel
      if (model === null) throw new Error(`Choose a ${info.label} model in Settings → Sessions.`)
      const apiKey = await deps.apiKey(provider)
      if (info.needsKey && apiKey === null) {
        throw new Error(`Add an API key for ${info.label} in Settings → Sessions.`)
      }
      const name = `${info.label} (${model})`
      if (provider === 'openai-compatible') {
        const baseUrl = settings.cloudBaseUrl
        if (baseUrl === null) throw new Error('Add the server address in Settings → Sessions.')
        // Ollama's native API takes a context size and unloads the model after; its /v1 does neither.
        if (await isOllama(baseUrl, deps.fetch)) {
          const onDevice = isLoopbackUrl(baseUrl)
          return createOllamaNotesWriter({ baseUrl, model, apiKey, onDevice, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
        }
        // Any other server is treated as off this machine, even on localhost: a local proxy
        // (LiteLLM and the like) may forward to a hosted model, and Lyra can't tell.
        return createModelNotesWriter(languageModel({ provider, model, apiKey, baseUrl }), name, {
          onDevice: false,
          budget: COMPATIBLE_BUDGET,
          outputTokens: COMPATIBLE_OUTPUT,
          callTimeoutMs: COMPATIBLE_CALL_TIMEOUT_MS
        })
      }
      // A hosted provider, even behind a *_BASE_URL proxy, counts as off this machine.
      const baseUrl = provider === 'anthropic' || provider === 'openai' ? deps.baseUrls[provider] : null
      return createModelNotesWriter(languageModel({ provider, model, apiKey, baseUrl }), name)
    }
  }
}

/**
 * Local model servers, over plain `fetch` (no SDK): a notes writer for Ollama's native API, and
 * the lookups Settings uses to find a server and its models. Every request goes only to the
 * address the user configured, or to the fixed loopback ports in `detectLocalServers`; nothing
 * here reaches the internet unless the user typed an internet address. No Electron imports, so
 * it is unit-tested with a fake `fetch`.
 */
import { z } from 'zod'
import { estimateTokens, fitText, mapReduceNotes, titlePrompt } from './notesChunks'
import { callSignal } from './notesJobs'
import {
  cleanTitle,
  MeetingNotes,
  NOTES_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  TitleSuggestion
} from './notesFormat'
import type { NotesWriter } from './notesWriter'

export type Fetch = typeof fetch

/** A server answers its version or model list at once; slower than this, it isn't there. */
const PROBE_TIMEOUT_MS = 2_000
/** A local model on a CPU can take minutes on a long prompt; this only catches a hung server. */
const OLLAMA_CALL_TIMEOUT_MS = 15 * 60_000
/** Room for a long meeting without the KV cache crowding out Whisper's memory. */
const MAX_CONTEXT = 16_384
/** What Ollama gives a model when nothing says otherwise; safe for any model. */
const FALLBACK_CONTEXT = 4_096
const MIN_CONTEXT = 2_048
const TITLE_OUTPUT_TOKENS = 100

/**
 * The server's root, from the address the user gave for the OpenAI-compatible API:
 * `http://localhost:11434/v1` → `http://localhost:11434`. A path before `/v1` (a reverse proxy)
 * is kept.
 */
export function serverRoot(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${url.origin}${path}`
}

/** The OpenAI-compatible API root: the address as given when it ends in `/v1`, else `<root>/v1`. */
function openAiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${serverRoot(baseUrl)}/v1`
}

const OllamaVersion = z.object({ version: z.string() })
const OllamaTags = z.object({ models: z.array(z.object({ name: z.string() })) })
const OpenAiModels = z.object({ data: z.array(z.object({ id: z.string() })) })
const OllamaShow = z.object({ model_info: z.record(z.string(), z.unknown()).optional() })
const OllamaChat = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional()
})
const OllamaError = z.object({ error: z.string() })

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function headers(apiKey: string | null): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  }
}

/** Fetches JSON and checks it with `schema`; a non-2xx answer throws with the server's message. */
async function getJson<T>(
  fetchFn: Fetch,
  url: string,
  schema: z.ZodType<T>,
  init: { method?: 'GET' | 'POST'; body?: unknown; apiKey?: string | null; signal: AbortSignal }
): Promise<T> {
  const response = await fetchFn(url, {
    method: init.method ?? 'GET',
    headers: headers(init.apiKey ?? null),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = OllamaError.safeParse(body)
    throw new HttpError(response.status, parsed.success ? parsed.data.error : `HTTP ${String(response.status)}`)
  }
  return schema.parse(body)
}

type ProbeEntry = { answer: Promise<boolean>; at: number }
const probes = new Map<string, ProbeEntry>()
/** A server that wasn't up may be started a minute later; a yes is kept for the app's life. */
const RETRY_NO_AFTER_MS = 60_000

/**
 * Whether the address the user configured is an Ollama server (it answers `/api/version`).
 * Asked once per address and remembered; only that host is ever asked.
 */
export async function isOllama(baseUrl: string, fetchFn: Fetch = fetch): Promise<boolean> {
  const root = serverRoot(baseUrl)
  const cached = probes.get(root)
  if (cached && ((await cached.answer) || Date.now() - cached.at < RETRY_NO_AFTER_MS)) return cached.answer
  const answer = getJson(fetchFn, `${root}/api/version`, OllamaVersion, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  }).then(
    () => true,
    () => false
  )
  probes.set(root, { answer, at: Date.now() })
  return answer
}

const contexts = new Map<string, Promise<number>>()

/** For tests: forget what earlier probes found. */
export function forgetProbes(): void {
  probes.clear()
  contexts.clear()
}

/** The model's trained context length from `/api/show`, or null when it doesn't say. */
export function contextLengthOf(modelInfo: Record<string, unknown> | undefined): number | null {
  for (const [key, value] of Object.entries(modelInfo ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value
  }
  return null
}

/** The `num_ctx` to run a model with: its own length, capped so the KV cache stays small. */
async function contextFor(fetchFn: Fetch, root: string, model: string, apiKey: string | null): Promise<number> {
  const key = `${root}\n${model}`
  let context = contexts.get(key)
  if (!context) {
    context = getJson(fetchFn, `${root}/api/show`, OllamaShow, {
      method: 'POST',
      body: { model },
      apiKey,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 5)
    }).then(
      (show) => Math.max(MIN_CONTEXT, Math.min(MAX_CONTEXT, contextLengthOf(show.model_info) ?? FALLBACK_CONTEXT)),
      // Unknown model or a hiccup: the chat call reports a real problem; ask again next time.
      () => {
        contexts.delete(key)
        return FALLBACK_CONTEXT
      }
    )
    contexts.set(key, context)
  }
  return context
}

export type OllamaChatOptions = {
  model: string
  system: string
  prompt: string
  schema: z.ZodObject
  numCtx: number
  numPredict: number
  /** Unload the model once this answer is done, freeing its memory for Whisper. */
  unload: boolean
}

/** The body of a non-streaming `/api/chat` call constrained to `schema`'s JSON shape. */
export function ollamaChatBody(options: OllamaChatOptions): Record<string, unknown> {
  return {
    model: options.model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.prompt }
    ],
    stream: false,
    format: z.toJSONSchema(options.schema, { target: 'draft-07' }),
    options: { num_ctx: options.numCtx, num_predict: options.numPredict, temperature: 0.2 },
    ...(options.unload ? { keep_alive: 0 } : {})
  }
}

/** The structured answer in a `/api/chat` reply, checked by `schema`. */
export function parseOllamaReply<T>(body: unknown, schema: z.ZodType<T>, name: string): T {
  const reply = OllamaChat.parse(body)
  if (reply.done_reason === 'length') {
    throw new Error(`${name} ran out of room before finishing the notes. Try a model with a longer context.`)
  }
  let json: unknown
  try {
    json = JSON.parse(reply.message.content)
  } catch {
    throw new Error(`${name} didn't return notes in the expected shape. Try again.`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error(`${name} didn't return notes in the expected shape. Try again.`)
  return parsed.data
}

/** A failure the person can act on. */
function ollamaError(name: string, root: string, model: string, error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason
  if (error instanceof HttpError) {
    if (error.status === 404) return new Error(`Ollama doesn't have ${model}. Run \`ollama pull ${model}\`, or pick another model.`)
    return new Error(`${name} error (${String(error.status)}): ${error.message}`, { cause: error })
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new Error(`${name} took too long to answer. Try again.`, { cause: error })
  }
  if (error instanceof TypeError) return new Error(`Couldn’t reach Ollama at ${root}. Is it running?`, { cause: error })
  return error
}

export type OllamaWriterOptions = {
  baseUrl: string
  model: string
  apiKey: string | null
  /** The server is on this computer (decided in writers.ts). */
  onDevice: boolean
  fetch?: Fetch
}

/**
 * Notes from Ollama's native `/api/chat`: unlike its `/v1` endpoint, it takes the context size
 * per request (`num_ctx`, from the model's own length) and a JSON schema to constrain the answer,
 * and unloads the model when a summary is done (`keep_alive: 0`).
 */
export function createOllamaNotesWriter(options: OllamaWriterOptions): NotesWriter {
  const fetchFn = options.fetch ?? fetch
  const root = serverRoot(options.baseUrl)
  const { model, apiKey } = options
  const name = `Ollama (${model})`
  const systemTokens = estimateTokens(NOTES_SYSTEM_PROMPT)

  async function chat<T>(
    chatOptions: Omit<OllamaChatOptions, 'model'>,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined
  ): Promise<T> {
    const body = await getJson(fetchFn, `${root}/api/chat`, z.unknown(), {
      method: 'POST',
      body: ollamaChatBody({ ...chatOptions, model }),
      apiKey,
      signal: callSignal(signal, OLLAMA_CALL_TIMEOUT_MS)
    })
    return parseOllamaReply(body, schema, name)
  }

  return {
    name,
    onDevice: options.onDevice,
    async notes(transcript, { signal } = {}) {
      try {
        const numCtx = await contextFor(fetchFn, root, model, apiKey)
        const numPredict = Math.min(2048, Math.floor(numCtx / 4))
        return await mapReduceNotes({
          transcript,
          budget: numCtx - numPredict - systemTokens - 64,
          count: estimateTokens,
          signal,
          ask: (prompt, { final }) =>
            chat(
              { system: NOTES_SYSTEM_PROMPT, prompt, schema: MeetingNotes, numCtx, numPredict, unload: final },
              MeetingNotes,
              signal
            )
        })
      } catch (error) {
        throw ollamaError(name, root, model, error, signal)
      }
    },
    async title(text, signal) {
      try {
        const numCtx = await contextFor(fetchFn, root, model, apiKey)
        const room = numCtx - TITLE_OUTPUT_TOKENS - estimateTokens(TITLE_SYSTEM_PROMPT) - 64
        const answer = await chat(
          {
            system: TITLE_SYSTEM_PROMPT,
            prompt: titlePrompt(fitText(text, room, estimateTokens)),
            schema: TitleSuggestion,
            numCtx,
            numPredict: TITLE_OUTPUT_TOKENS,
            unload: true
          },
          TitleSuggestion,
          signal
        )
        return cleanTitle(answer.title)
      } catch (error) {
        throw ollamaError(name, root, model, error, signal)
      }
    },
    canTitle: () => Promise.resolve(true)
  }
}

/**
 * The model ids a local server offers: Ollama's `/api/tags`, else an OpenAI-compatible
 * `/v1/models` (LM Studio, llama.cpp's server, vLLM). Asks only the address the user gave; call
 * it on an explicit user action (opening the model picker), not in the background.
 */
export async function listLocalModels(
  baseUrl: string,
  options: { apiKey?: string | null; fetch?: Fetch } = {}
): Promise<string[]> {
  const fetchFn = options.fetch ?? fetch
  const apiKey = options.apiKey ?? null
  const signal = (): AbortSignal => AbortSignal.timeout(PROBE_TIMEOUT_MS * 2)
  if (await isOllama(baseUrl, fetchFn)) {
    const tags = await getJson(fetchFn, `${serverRoot(baseUrl)}/api/tags`, OllamaTags, { apiKey, signal: signal() })
    return tags.models.map((entry) => entry.name)
  }
  const models = await getJson(fetchFn, `${openAiRoot(baseUrl)}/models`, OpenAiModels, { apiKey, signal: signal() })
  return models.data.map((entry) => entry.id)
}

export type LocalServer = {
  kind: 'ollama' | 'lm-studio'
  /** What to put in Settings as the OpenAI-compatible server address. */
  baseUrl: string
}

/**
 * Which of the usual local servers are running on this computer: Ollama on 11434 and LM Studio
 * on 1234. Loopback requests only, with short timeouts. Call it only on an explicit user action
 * (a "Find local servers" button in Settings), never on startup or on a timer.
 */
export async function detectLocalServers(fetchFn: Fetch = fetch): Promise<LocalServer[]> {
  const ask = <T>(url: string, schema: z.ZodType<T>): Promise<boolean> =>
    getJson(fetchFn, url, schema, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
      () => true,
      () => false
    )
  const [ollama, lmStudio] = await Promise.all([
    ask('http://127.0.0.1:11434/api/version', OllamaVersion),
    ask('http://127.0.0.1:1234/v1/models', OpenAiModels)
  ])
  const found: LocalServer[] = []
  if (ollama) found.push({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })
  if (lmStudio) found.push({ kind: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1' })
  return found
}

import {
  APICallError,
  generateText,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  Output,
  type LanguageModel
} from 'ai'
import type { DownloadProgress } from '../models'
import { estimateTokens, fitText, mapReduceNotes, titlePrompt, type TokenCounter } from './notesChunks'
import { CALL_TIMEOUT_MS, callSignal, isAbort } from './notesJobs'
import {
  cleanTitle,
  MeetingNotes,
  NOTES_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  TitleSuggestion
} from './notesFormat'

export type NotesOptions = {
  onDownload?: DownloadProgress | undefined
  /** Aborts the run: the job was replaced, cancelled, or the app is quitting. */
  signal?: AbortSignal | undefined
}

/**
 * What writes a session's notes and suggests its title. Callers depend on this, never on a model
 * SDK: `createModelNotesWriter` runs any AI SDK model (Anthropic, OpenAI, Google, an
 * OpenAI-compatible server), `createOllamaNotesWriter` (ollama.ts) talks to Ollama directly,
 * `createLocalNotesWriter` (notesLocal.ts) runs the on-device model, and `createFakeNotesWriter`
 * answers from fixed values for tests.
 */
export type NotesWriter = {
  /** For logs and status, e.g. `anthropic:claude-opus-5-5` or `local`. */
  readonly name: string
  /**
   * Nothing sent to this writer leaves the computer: the built-in model, or a server on a
   * loopback address. Decides whether the user's typed notes may go along with a title request.
   */
  readonly onDevice: boolean
  notes(transcript: string, options?: NotesOptions): Promise<MeetingNotes>
  /** A short heading, or null when the model gave nothing usable. */
  title(text: string, signal?: AbortSignal): Promise<string | null>
  /**
   * Whether a title can be asked for now without a slow first step (a 2 GB download). Notes may
   * still take one; titles never start it.
   */
  canTitle(): Promise<boolean>
}

/** A failure the person can act on, with the provider's own error as the cause. */
function friendlyError(name: string, error: unknown, signal?: AbortSignal): unknown {
  // A replaced or cancelled run keeps its own reason; a call that ran out of time says so.
  if (signal?.aborted) return signal.reason
  if (isAbort(error)) return new Error(`${name} took too long to answer. Try again.`, { cause: error })
  if (LoadAPIKeyError.isInstance(error)) {
    return new Error(`No API key for ${name}. Add one in Settings → Sessions.`, { cause: error })
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    return new Error(`${name} didn't return notes in the expected shape. Try again.`, { cause: error })
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    if (status === 401 || status === 403) {
      return new Error(`${name} rejected the API key. Check it in Settings → Sessions.`, { cause: error })
    }
    if (status === 429) return new Error(`${name} is rate-limiting this key. Try again in a minute.`, { cause: error })
    if (status === 404) return new Error(`${name} doesn't know that model. Check it in Settings → Sessions.`, { cause: error })
    if (status === undefined) return new Error(`Couldn’t reach ${name}. Check your connection.`, { cause: error })
    return new Error(`${name} error (${String(status)}): ${error.message}`, { cause: error })
  }
  return error
}

/** How much a model may write: notes are short, and a cap stops a runaway answer billing on. */
const NOTES_OUTPUT_TOKENS = 2048
const TITLE_OUTPUT_TOKENS = 100

export type ModelWriterOptions = {
  /** See `NotesWriter.onDevice`; false unless the caller knows the server is on this machine. */
  onDevice?: boolean
  /**
   * Tokens of transcript one call may carry; a longer meeting is summarized in parts and merged.
   * Hosted models take a large budget; an unknown server gets a small one, since servers like
   * Ollama's `/v1` cut a long prompt silently instead of failing.
   */
  budget?: number
  /** Caps each answer; defaults to NOTES_OUTPUT_TOKENS. */
  outputTokens?: number
  /** Counts tokens for the budget; defaults to a conservative estimate. */
  count?: TokenCounter
  /** How long one call may take before it counts as hung; a local server may be slow. */
  callTimeoutMs?: number
}

/** Long enough for any meeting a hosted model's context holds (all are 128k tokens or more). */
export const HOSTED_BUDGET = 100_000

/** Notes and titles from any AI SDK language model, as structured output checked by zod. */
export function createModelNotesWriter(model: LanguageModel, name: string, options: ModelWriterOptions = {}): NotesWriter {
  const budget = options.budget ?? HOSTED_BUDGET
  const outputTokens = options.outputTokens ?? NOTES_OUTPUT_TOKENS
  const count = options.count ?? estimateTokens
  const timeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
  return {
    name,
    onDevice: options.onDevice ?? false,
    async notes(transcript, { signal } = {}) {
      try {
        return await mapReduceNotes({
          transcript,
          budget,
          count,
          signal,
          ask: async (prompt) => {
            const { output } = await generateText({
              model,
              instructions: NOTES_SYSTEM_PROMPT,
              prompt,
              output: Output.object({ schema: MeetingNotes, name: 'meeting_notes' }),
              maxOutputTokens: outputTokens,
              abortSignal: callSignal(signal, timeoutMs)
            })
            return output
          }
        })
      } catch (error) {
        throw friendlyError(name, error, signal)
      }
    },
    async title(text, signal) {
      try {
        const { output } = await generateText({
          model,
          instructions: TITLE_SYSTEM_PROMPT,
          // A small server would cut a long note silently; the start is enough for a title.
          prompt: titlePrompt(fitText(text, budget, count)),
          output: Output.object({ schema: TitleSuggestion, name: 'title' }),
          maxOutputTokens: TITLE_OUTPUT_TOKENS,
          abortSignal: callSignal(signal, timeoutMs)
        })
        return cleanTitle(output.title)
      } catch (error) {
        throw friendlyError(name, error, signal)
      }
    },
    canTitle: () => Promise.resolve(true)
  }
}

export type WriterTest = { ok: true; ms: number } | { ok: false; error: string }

/**
 * Runs one tiny structured request (a title for a two-line note) through a writer, for a
 * Settings "Test" button: success, or the readable error the writer gives. Sends only the fixed
 * sample text below, never anything from the user's notes.
 */
export async function testNotesWriter(writer: NotesWriter, signal?: AbortSignal): Promise<WriterTest> {
  const started = Date.now()
  try {
    if (!(await writer.canTitle())) {
      return { ok: false, error: 'The notes model isn’t downloaded yet. Write a summary once to download it.' }
    }
    const sample = 'Alex: Let’s plan the garden this weekend.\nSam: I’ll buy the seeds and the soil.'
    await writer.title(sample, signal)
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A writer that answers with fixed values and records what it was asked: for tests. */
export function createFakeNotesWriter(answer: { notes: MeetingNotes; title: string | null }): NotesWriter & {
  readonly asked: string[]
} {
  const asked: string[] = []
  return {
    name: 'fake',
    onDevice: true,
    asked,
    notes(transcript) {
      asked.push(transcript)
      return Promise.resolve(answer.notes)
    },
    title(text) {
      asked.push(text)
      return Promise.resolve(answer.title)
    },
    canTitle: () => Promise.resolve(true)
  }
}

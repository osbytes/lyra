import {
  APICallError,
  generateText,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  Output,
  type LanguageModel
} from 'ai'
import type { DownloadProgress } from '../models'
import {
  cleanTitle,
  MeetingNotes,
  NOTES_SYSTEM_PROMPT,
  tidyNotes,
  TITLE_SYSTEM_PROMPT,
  TitleSuggestion
} from './notesFormat'

/**
 * What writes a session's notes and suggests its title. Callers depend on this, never on a model
 * SDK: `createModelNotesWriter` runs any AI SDK model (Anthropic, OpenAI, Google, an
 * OpenAI-compatible server), `createLocalNotesWriter` (notesLocal.ts) runs the on-device model,
 * and `createFakeNotesWriter` answers from fixed values for tests.
 */
export type NotesWriter = {
  /** For logs and status, e.g. `anthropic:claude-opus-5-5` or `local`. */
  readonly name: string
  notes(transcript: string, onDownload?: DownloadProgress): Promise<MeetingNotes>
  /** A short heading, or null when the model gave nothing usable. */
  title(text: string): Promise<string | null>
  /**
   * Whether a title can be asked for now without a slow first step (a 2 GB download). Notes may
   * still take one; titles never start it.
   */
  canTitle(): Promise<boolean>
}

/** A failure the person can act on, with the provider's own error as the cause. */
function friendlyError(name: string, error: unknown): unknown {
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

/** Notes and titles from any AI SDK language model, as structured output checked by zod. */
export function createModelNotesWriter(model: LanguageModel, name: string): NotesWriter {
  return {
    name,
    async notes(transcript) {
      try {
        const { output } = await generateText({
          model,
          instructions: NOTES_SYSTEM_PROMPT,
          prompt: `Transcript:\n\n${transcript}`,
          output: Output.object({ schema: MeetingNotes, name: 'meeting_notes' })
        })
        return tidyNotes(output)
      } catch (error) {
        throw friendlyError(name, error)
      }
    },
    async title(text) {
      try {
        const { output } = await generateText({
          model,
          instructions: TITLE_SYSTEM_PROMPT,
          prompt: `Note:\n\n${text}`,
          output: Output.object({ schema: TitleSuggestion, name: 'title' })
        })
        return cleanTitle(output.title)
      } catch (error) {
        throw friendlyError(name, error)
      }
    },
    canTitle: () => Promise.resolve(true)
  }
}

/** A writer that answers with fixed values and records what it was asked: for tests. */
export function createFakeNotesWriter(answer: { notes: MeetingNotes; title: string | null }): NotesWriter & {
  readonly asked: string[]
} {
  const asked: string[] = []
  return {
    name: 'fake',
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

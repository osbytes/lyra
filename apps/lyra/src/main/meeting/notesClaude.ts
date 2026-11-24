import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { getSettings } from '../settings'
import {
  NOTES_SCHEMA,
  NOTES_SYSTEM_PROMPT,
  parseNotes,
  parseTitle,
  TITLE_SCHEMA,
  TITLE_SYSTEM_PROMPT,
  type MeetingNotes
} from './notesFormat'

/** The model Lyra is tested with; Settings or ANTHROPIC_MODEL can choose another. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

function claudeModel(): string {
  return getSettings().claudeModel ?? config().anthropicModel ?? DEFAULT_CLAUDE_MODEL
}

/** ANTHROPIC_BASE_URL, when set, points the client at a proxy or gateway. */
function client(apiKey: string): Anthropic {
  const { anthropicBaseUrl } = config()
  return new Anthropic(anthropicBaseUrl ? { apiKey, baseURL: anthropicBaseUrl } : { apiKey })
}

/** Meeting notes from Claude. Only called when the user chose Claude and saved a key. */
export async function claudeNotes(apiKey: string, transcript: string): Promise<MeetingNotes> {
  try {
    const message = await client(apiKey).beta.messages
      .stream({
        model: claudeModel(),
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        // On a policy decline the API retries on a suitable fallback model in the same call.
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
        system: NOTES_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }]
      })
      .finalMessage()

    if (message.stop_reason === 'refusal') throw new Error('Claude declined to summarize this meeting')
    if (message.stop_reason === 'max_tokens') throw new Error('Claude’s notes were cut off')
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    return parseNotes(JSON.parse(text))
  } catch (error) {
    throw friendlyError(error)
  }
}

/** A title suggestion from Claude; null if it gave nothing usable. */
export async function claudeTitle(apiKey: string, text: string): Promise<string | null> {
  try {
    const message = await client(apiKey).beta.messages
      .stream({
        model: claudeModel(),
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // A few words: no need to think hard.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: TITLE_SCHEMA } },
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Note:\n\n${text}` }]
      })
      .finalMessage()
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return null
    const reply = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    const parsed: unknown = JSON.parse(reply)
    return parseTitle(parsed)
  } catch (error) {
    throw friendlyError(error)
  }
}

/** Claude API failures as messages a person can act on. */
function friendlyError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error('Claude rejected the API key. Check it in Settings → Sessions.', { cause: error })
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error('Claude is rate-limiting this key. Try again in a minute.', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error('Couldn’t reach Claude. Check your internet connection.', { cause: error })
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`Claude API error (${String(error.status)}): ${error.message}`, { cause: error })
  }
  return error
}

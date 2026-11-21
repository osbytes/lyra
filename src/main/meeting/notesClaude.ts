import Anthropic from '@anthropic-ai/sdk'
import { NOTES_SCHEMA, NOTES_SYSTEM_PROMPT, parseNotes, type MeetingNotes } from './notesFormat'

const MODEL = 'claude-opus-5-5'

/** Meeting notes from Claude. Only called when the user chose Claude and saved a key. */
export async function claudeNotes(apiKey: string, transcript: string): Promise<MeetingNotes> {
  const client = new Anthropic({ apiKey })
  try {
    const message = await client.beta.messages
      .stream({
        model: MODEL,
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
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude rejected the API key. Check it in Settings → Meeting notes.', { cause: error })
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error('Claude is rate-limiting this key. Try again in a minute.', { cause: error })
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new Error('Couldn’t reach Claude. Check your internet connection.', { cause: error })
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Claude API error (${String(error.status)}): ${error.message}`, { cause: error })
    }
    throw error
  }
}

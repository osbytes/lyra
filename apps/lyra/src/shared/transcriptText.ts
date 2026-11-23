/**
 * How dictated text joins what's already written: voice commands ("new paragraph") become line
 * breaks, and spacing and capitals follow the text before it. Shared because the transcriber
 * writes in main while the editor previews unconfirmed words in the window.
 */

const VOICE_COMMANDS: [RegExp, string][] = [
  [/,?\s*\b(?:new|next) paragraph\b[.,!?]*\s*/gi, '\n\n'],
  [/,?\s*\bnew line\b[.,!?]*\s*/gi, '\n']
]

function capitalize(text: string): string {
  return text.replace(/^[a-z]/, (ch) => ch.toUpperCase())
}

/** Turns spoken formatting commands ("new paragraph") into whitespace. */
export function applyVoiceCommands(text: string): string {
  let out = text
  for (const [pattern, replacement] of VOICE_COMMANDS) out = out.replace(pattern, replacement)
  return out.replace(/\n([a-z])/g, (_match, ch: string) => `\n${ch.toUpperCase()}`)
}

/** Appends a dictated chunk to the page body with sensible spacing and capitalization. */
export function appendTranscript(body: string, chunk: string): string {
  const text = applyVoiceCommands(chunk.trim())
  // A bare "new paragraph" leaves only line breaks; never start a page with them.
  if (!text.trim()) return body.trim() ? body.trimEnd() + text : body
  if (!body.trim()) return capitalize(text.trimStart())

  const trimmed = body.trimEnd()
  const endsLine = body.endsWith("\n") || text.startsWith("\n")
  const endsSentence = /[.!?:]["')\]]?$/.test(trimmed)
  const next = endsLine || endsSentence ? capitalize(text) : text
  const attaches = endsLine || /\s$/.test(body) || /^[.,!?;:]/.test(text)
  const separator = attaches ? '' : ' '
  return `${body}${separator}${next}`
}

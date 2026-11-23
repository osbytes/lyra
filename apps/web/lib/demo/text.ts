// Pure text helpers copied from the app so the demo behaves like it:
// apps/lyra/src/renderer/src/text/transcript.ts, components/Editor.tsx (mapPosition),
// lib/format.ts and shared/sessionDoc.ts (normalizeTag).

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
  const endsLine = body.endsWith('\n') || text.startsWith('\n')
  const endsSentence = /[.!?:]["')\]]?$/.test(trimmed)
  const next = endsLine || endsSentence ? capitalize(text) : text
  const attaches = endsLine || /\s$/.test(body) || /^[.,!?;:]/.test(text)
  const separator = attaches ? '' : ' '
  return `${body}${separator}${next}`
}

/**
 * Where a position lands after `before` became `after` through one contiguous edit. Positions
 * before the edit stay put; positions after it move with the text.
 */
export function mapPosition(before: string, after: string, position: number): number {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--
    endAfter--
  }
  if (position <= start) return position
  if (position >= endBefore) return position + (after.length - before.length)
  return endAfter
}

/** Lower-case, no leading `#`, spaces as hyphens: `#Design Review` → `design-review`. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-')
}

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230))
}

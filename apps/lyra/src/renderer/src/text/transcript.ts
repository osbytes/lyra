const PROMPT_CHARS = 300

/**
 * Whisper copies the style of its prompt. On an empty page there's nothing to
 * copy, so give it a punctuated sentence to nudge it toward full punctuation.
 */
const STYLE_SEED = 'Okay, so here are my thoughts, written out in full sentences.'

/**
 * Builds the context prompt for Whisper: the page title plus the tail of what
 * has been written. This keeps punctuation, casing, and vocabulary consistent
 * across utterances instead of each chunk starting from scratch.
 */
export function promptFor(title: string, body: string): string {
  const tail = body.slice(-PROMPT_CHARS).replace(/\s+/g, ' ').trim()
  const start = tail.length === PROMPT_CHARS ? tail.indexOf(' ') + 1 : 0
  const heading = title && title !== 'Untitled' ? `${title}. ` : ''
  return `${heading}${tail.slice(start)}`.trim() || STYLE_SEED
}

/**
 * Splits off a trailing "new"/"next" that might be the start of a voice command
 * whose second word ("paragraph") hasn't been committed yet.
 */
export function holdBackCommand(text: string): [ready: string, held: string] {
  const match = /\s*\b(?:new|next)$/i.exec(text)
  return match ? [text.slice(0, match.index), match[0]] : [text, '']
}

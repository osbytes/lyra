/** Hues in the speaker palette (styles.css `--speaker-1` … `--speaker-8`). */
export const SPEAKER_HUES = 8

/**
 * A speaker's slot: its position in the session's speaker list, so each speaker keeps one hue
 * and one shape for the life of the session, everywhere it shows. Slots past the palette share a
 * neutral badge and rely on the name; the system never invents a ninth hue.
 */
export function speakerSlot(speakers: readonly { id: string }[], id: string): number {
  return Math.max(0, speakers.findIndex((speaker) => speaker.id === id))
}

/**
 * The badge's monogram: a named person's initials (first and last word), or the number of an
 * unnamed "Speaker 3". At most two letters, upper-cased.
 */
export function monogram(name: string): string {
  const unnamed = /^speaker\s+(\d+)$/i.exec(name.trim())
  if (unnamed?.[1]) return unnamed[1]
  const words = name
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
  const first = words[0]
  if (!first) return '?'
  const last = words.length > 1 ? words.at(-1) : undefined
  // By code point, so a letter outside the basic plane isn't cut in half.
  const initial = (word: string): string => String.fromCodePoint(word.codePointAt(0) ?? 63)
  const letters = initial(first) + (last ? initial(last) : '')
  return letters.toLocaleUpperCase()
}

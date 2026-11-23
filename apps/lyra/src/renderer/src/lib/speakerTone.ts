/** Number of pastel tones in styles.css (`.speaker-avatar[data-tone]`). */
const SPEAKER_TONES = 8

/**
 * A speaker's avatar tone: its position in the session's speaker list, so each speaker in a
 * session gets a different colour (until there are more speakers than tones) and keeps it
 * everywhere the session shows it.
 */
export function speakerTone(speakers: readonly { id: string }[], id: string): string {
  const index = speakers.findIndex((speaker) => speaker.id === id)
  return String(Math.max(0, index) % SPEAKER_TONES)
}

import type { AudioTrack } from '../shared/types'
import type { Untranscribed } from './livePass'
import type { TranscribedChunk } from './transcriber'

/**
 * What resuming an interrupted transcription runs, kept pure for tests: the stretches of audio
 * to transcribe again, and which of the words that come back are new.
 */

/** One take's untranscribed audio: every track from the earliest mark to the latest end. */
export type ResumeSpan = { take: number; from: number; to: number; marks: Untranscribed[] }

/**
 * The marks of each take as one span. The tracks of a take are transcribed together, as when it
 * was recorded (on a call the mic's echo is gated against the system track), so a track whose
 * mark starts later is heard again from the earlier one; `newWords` drops what it already had.
 */
export function resumeSpans(marks: readonly Untranscribed[]): ResumeSpan[] {
  const byTake = new Map<number, Untranscribed[]>()
  for (const mark of marks) byTake.set(mark.take, [...(byTake.get(mark.take) ?? []), mark])
  return [...byTake.entries()]
    .sort(([a], [b]) => a - b)
    .map(([take, group]) => ({
      take,
      from: Math.min(...group.map((mark) => mark.start)),
      to: Math.max(...group.map((mark) => mark.end)),
      marks: group
    }))
}

/** The tracks a span transcribes. */
export function spanTracks(span: ResumeSpan): AudioTrack[] {
  return [...new Set(span.marks.map((mark) => mark.track))]
}

/**
 * The chunk with only the words its track's mark left untranscribed: a word starting before the
 * mark was already kept, by the take itself. Null when none are left.
 */
export function newWords(chunk: TranscribedChunk, marks: readonly Untranscribed[]): TranscribedChunk | null {
  const words = chunk.words.filter((word) =>
    marks.some((mark) => mark.track === chunk.track && word.start >= mark.start && word.start < mark.end)
  )
  return words.length ? { ...chunk, words } : null
}

/**
 * Where one speaker's turn ends and the next begins. Clustering says who is who from windows a
 * few seconds long, so the point where its labels change is only good to about a second, and in
 * quick back-and-forth that hands the first or last words of a turn to the wrong person: on the
 * eval sessions most words given to the wrong speaker were within a second of a change, not in
 * the middle of a turn (docs/EVALS.md). Two corrections, both pure:
 *
 * - `refineEdges` moves each change to where the voice on either side best matches its speaker,
 *   with voiceprints of the audio just before and just after each candidate point.
 * - `snapTurns` then moves the change, among the words, to the nearest pause or sentence end:
 *   people rarely hand over mid-phrase, and Whisper's word times are themselves a little off.
 */
import type { Span } from './clustering'

type Turn = Span & { speaker: number }

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/** How far a change may move, how finely candidates are tried, and the audio judged on each side. */
export const EDGE_REACH_SECONDS = 1.5
export const EDGE_STEP_SECONDS = 0.25
export const EDGE_SIDE_SECONDS = 2
/** Each turn keeps at least this much: a voiceprint of less says nothing. */
const EDGE_MIN_SECONDS = 0.5
/** Turns further apart than this have a pause between them, which is the change. */
const EDGE_MAX_GAP_SECONDS = 0.5

/**
 * Moves the boundary between two adjoining turns of different speakers to the point, within
 * `EDGE_REACH_SECONDS`, where the audio before it sounds most like the first speaker (and least
 * like the second) and the audio after it the other way round. `embed` gives a unit voiceprint
 * of a stretch; `centres` the speakers' mean voiceprints; `sameSide` says whether two turns
 * were heard on the same track (a change between the mic and the system track is already exact,
 * and a voiceprint across it would be of two tracks mixed).
 */
export function refineEdges(
  turns: readonly Turn[],
  centres: ReadonlyMap<number, readonly number[]>,
  embed: (start: number, end: number) => readonly number[],
  sameSide: (a: Turn, b: Turn) => boolean = () => true
): Turn[] {
  const out = turns.map((turn) => ({ ...turn }))
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]
    const b = out[i + 1]
    if (!a || !b || a.speaker === b.speaker || b.start - a.end > EDGE_MAX_GAP_SECONDS || !sameSide(a, b)) continue
    const first = centres.get(a.speaker)
    const second = centres.get(b.speaker)
    if (!first || !second) continue
    const middle = (a.end + b.start) / 2
    const from = Math.max(a.start + EDGE_MIN_SECONDS, middle - EDGE_REACH_SECONDS)
    const to = Math.min(b.end - EDGE_MIN_SECONDS, middle + EDGE_REACH_SECONDS)
    let best: { score: number; at: number } | null = null
    for (let at = from; at <= to + 1e-9; at += EDGE_STEP_SECONDS) {
      const before = embed(Math.max(a.start, at - EDGE_SIDE_SECONDS), at)
      const after = embed(at, Math.min(b.end, at + EDGE_SIDE_SECONDS))
      const score = dot(before, first) - dot(before, second) + dot(after, second) - dot(after, first)
      if (Number.isFinite(score) && (!best || score > best.score)) best = { score, at }
    }
    if (!best) continue
    a.end = best.at
    b.start = best.at
  }
  return out
}

/** A change moves at most this far in time, and past at most this many words. */
export const SNAP_REACH_SECONDS = 1
const SNAP_WORDS = 4
/** What a sentence end is worth next to a pause, in seconds of pause. */
const SENTENCE_END = 0.3
/** A pause counts up to this long; any longer is as sure. */
const PAUSE_CAP = 1
/** Each word a change is moved costs this, so of two equal pauses the nearer wins. */
const PER_WORD = 0.05
/** A cut point scoring under this (no real pause, no sentence end) isn't worth moving to. */
const MIN_SCORE = 0.15

const endsSentence = (text: string): boolean => /[.?!]["')\]]?\s*$/.test(text)

type SnapWord = Span & { text: string; track?: string | null }

/**
 * Moves each change of speaker, among the words, to the best pause or sentence end within
 * `SNAP_REACH_SECONDS`: the words between the old point and the new one go to the turn they now
 * belong to. Only within the two turns that meet there (each keeps at least a word), only
 * among words of one track (the track a word was heard on already separates the mic from the
 * far end), and never across a word that is `fixed` (the user chose its speaker, or it isn't
 * settled yet).
 */
export function snapTurns(
  words: readonly SnapWord[],
  speakers: readonly number[],
  fixed: readonly boolean[] = []
): number[] {
  const out = [...speakers]
  const movable = (from: number, to: number, speaker: number | undefined, track: SnapWord['track']): boolean => {
    for (let k = from; k <= to; k++) {
      if (speakers[k] !== speaker || fixed[k] === true || words[k]?.track !== track) return false
    }
    return true
  }
  for (let i = 0; i + 1 < words.length; i++) {
    const left = words[i]
    const right = words[i + 1]
    if (!left || !right || speakers[i] === speakers[i + 1]) continue
    if (left.track !== right.track || fixed[i] === true || fixed[i + 1] === true) continue
    let best = i
    let bestScore = -Infinity
    for (let j = Math.max(0, i - SNAP_WORDS); j <= Math.min(words.length - 2, i + SNAP_WORDS); j++) {
      const word = words[j]
      const next = words[j + 1]
      if (!word || !next || Math.abs(word.end - left.end) > SNAP_REACH_SECONDS) continue
      // Words changing hands must all be of the turn they leave, and of this track; and the turn
      // keeps a word, or a one-word reply would be swallowed by the turn beside it.
      if (j < i && !(movable(j + 1, i, speakers[i], left.track) && speakers[j] === speakers[i])) continue
      if (j > i && !(movable(i + 1, j, speakers[i + 1], left.track) && speakers[j + 1] === speakers[i + 1])) continue
      const pause = Math.min(PAUSE_CAP, Math.max(0, next.start - word.end))
      const score = pause + (endsSentence(word.text) ? SENTENCE_END : 0) - PER_WORD * Math.abs(j - i)
      if (score > bestScore) {
        best = j
        bestScore = score
      }
    }
    if (best === i || bestScore < MIN_SCORE) continue
    const taker = best < i ? speakers[i + 1] : speakers[i]
    if (taker === undefined) continue
    for (let k = Math.min(best, i) + 1; k <= Math.max(best, i); k++) out[k] = taker
  }
  return out
}

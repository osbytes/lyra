import { cosine } from '../voiceStore'
import { MIC_SIDE } from './clustering'
import { guessModel } from './speakerModel'

/**
 * Rules for naming, merging and remembering speakers, apart from the Electron and file code that
 * uses them so they're unit-tested. None of this changes how speech is clustered.
 */

type Span = { start: number; end: number }
type SideSpan = Span & { micShare: number }

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** Two speakers talking over each other for this long in all can't be one person. */
export const SAME_PERSON_MAX_OVERLAP_SECONDS = 2

/** Talk-weighted share of a speaker's energy on the mic track; 1 with no system track. */
export function micShareOf(segments: readonly SideSpan[]): number {
  const seconds = segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  return seconds ? segments.reduce((sum, s) => sum + s.micShare * (s.end - s.start), 0) / seconds : 0
}

/**
 * Whether two diarized speakers could be one person, judged by when and where they spoke, not by
 * voice: one person doesn't talk over themselves for long, and isn't both at this computer's mic
 * and on the far end of a call.
 */
export function couldBeOnePerson(a: readonly SideSpan[], b: readonly SideSpan[], hasSystemTrack: boolean): boolean {
  if (hasSystemTrack && (micShareOf(a) >= MIC_SIDE) !== (micShareOf(b) >= MIC_SIDE)) return false
  let shared = 0
  for (const x of a) for (const y of b) shared += overlap(x, y)
  return shared < SAME_PERSON_MAX_OVERLAP_SECONDS
}

/**
 * Whether two speakers' voiceprints rule out their being one person. An empty voiceprint (too
 * little speech to take one) rules nothing out.
 */
export function differentVoices(a: readonly number[], b: readonly number[], minSimilarity: number): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return cosine(a, b) < minSimilarity
}

/**
 * Which unnamed speaker is "me" when no saved voice found me: of the speakers mostly on the mic
 * track (while a call's audio was on the system track), the one who talked most; ties go to who
 * spoke first. The first mic-side voice could be someone who walked past the desk.
 */
export function pickSelfSpeaker(
  candidates: readonly { speaker: number; seconds: number; micShare: number }[],
  minMicShare: number
): number | null {
  let best: { speaker: number; seconds: number } | null = null
  for (const candidate of candidates) {
    if (candidate.micShare < minMicShare) continue
    if (!best || candidate.seconds > best.seconds) best = candidate
  }
  return best?.speaker ?? null
}

export type PassVoiceprints = {
  segments: readonly { id: string; cluster: string | null }[]
  clusters: readonly { id: string; embedding: number[]; model?: string | undefined }[]
}

export type SessionVoiceprint = { vector: number[]; model: string }

type CurrentLine = { id: string; rawId: string | null; cluster: string | null }

/**
 * Each speaker's voiceprint, from the newest pass in which that speaker owns lines still in the
 * transcript: a line whose pass (found by its raw id) gave it to the speaker and which still
 * shows them. Speaker ids could be handed out again after one was deleted, so an older pass's
 * voiceprint under the same id may be another voice; a pass vouches only for lines it made.
 * A speaker the user made by moving lines has no voiceprint of their own, and gets none.
 */
export function ownedVoiceprints(
  passes: readonly PassVoiceprints[],
  transcript: readonly CurrentLine[]
): Map<string, SessionVoiceprint> {
  const shown = new Map<string, string>()
  for (const line of transcript) if (line.cluster) shown.set(line.rawId ?? line.id, line.cluster)
  const found = new Map<string, SessionVoiceprint>()
  for (const pass of passes) {
    const owners = new Set<string>()
    for (const segment of pass.segments) {
      if (segment.cluster !== null && shown.get(segment.id) === segment.cluster) owners.add(segment.cluster)
    }
    for (const cluster of pass.clusters) {
      if (found.has(cluster.id) || !owners.has(cluster.id) || !cluster.embedding.length) continue
      found.set(cluster.id, { vector: cluster.embedding, model: cluster.model ?? guessModel(cluster.embedding) })
    }
  }
  return found
}

/**
 * Lines whose speaker the user chose: marked so in the document (`userCluster`), which covers
 * live lines too. Documents from before the mark fall back to comparing with the pass: a line
 * its pass gave one speaker that now shows another was moved. A live line there has no record
 * of the speaker it was heard as, so an unmarked move on one can't be told apart.
 */
export function movedLines<T extends CurrentLine & Span & { userCluster?: boolean }>(
  transcript: readonly T[],
  passClusters: ReadonlyMap<string, string | null>
): (T & { cluster: string })[] {
  return transcript.flatMap((line) => {
    const { cluster } = line
    if (cluster === null) return []
    const origin = passClusters.get(line.rawId ?? line.id)
    const moved = line.userCluster === true || (origin !== undefined && origin !== cluster)
    return moved ? [{ ...line, cluster }] : []
  })
}

/**
 * The speaker the user chose for each word, where it falls in a line they moved: a new pass keeps
 * their correction instead of handing the words back to the speaker the model heard.
 */
export function pinnedSpeakers(words: readonly Span[], moved: readonly (Span & { cluster: string })[]): (string | null)[] {
  return words.map((word) => {
    const middle = (word.start + word.end) / 2
    return moved.find((line) => line.start <= middle && middle <= line.end)?.cluster ?? null
  })
}

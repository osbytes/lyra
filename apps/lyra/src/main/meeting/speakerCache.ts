/**
 * What the speaker-activity model remembers of a recording between chunks (`speakerActivity.ts`):
 * a short queue of the latest frames, and a cache holding the frames that best show each speaker,
 * grouped by speaker in the order they first spoke. Every chunk is read together with both, which
 * is how a voice keeps one output channel for a whole meeting. The rules are the model's own
 * (NVIDIA's Arrival-Order Speaker Cache), ported as they are: the model was trained against
 * them, so a different policy here would cost accuracy. Pure, so it's unit-tested.
 */

export type CachePolicy = {
  /** Output channels of the model: the most people it can tell apart. */
  speakers: number
  /** Frames the cache holds once full. */
  cacheFrames: number
  /** Latest frames kept in order ahead of the cache. */
  queueFrames: number
  /** Fewest frames moved from the queue to the cache when the queue overflows. */
  updateFrames: number
}

/** The model's settings for reading a whole recording in half-minute chunks. */
export const WHOLE_RECORDING: CachePolicy = { speakers: 8, cacheFrames: 264, queueFrames: 40, updateFrames: 300 }

/** A probability under this (or over one minus it) counts as this when frames are scored. */
const SCORE_FLOOR = 0.25
/** A frame counts as a speaker's when the model gives them more than this. */
const SPEAKING = 0.5
/** Frames just leaving the queue are preferred a little over ones already cached. */
const LATEST_BOOST = 0.05
const LOG_HALF = Math.log(0.5)

type Frame = Float32Array

/**
 * How well each frame shows each speaker alone: high when they are speaking and nobody else is.
 * Frames where the speaker isn't talking can't be kept for them.
 */
function frameScores(probabilities: readonly Frame[], speakers: number, minPositive: number): number[][] {
  const scores = probabilities.map((row) => {
    const others = Array.from(row, (p) => Math.log(Math.max(1 - p, SCORE_FLOOR)))
    const everyoneQuiet = others.reduce((sum, value) => sum + value, 0)
    return Array.from(row, (p, speaker) =>
      p > SPEAKING ? Math.log(Math.max(p, SCORE_FLOOR)) - (others[speaker] ?? 0) + everyoneQuiet - LOG_HALF : -Infinity
    )
  })
  // A speaker with enough clean frames gives up their overlapped ones.
  for (let speaker = 0; speaker < speakers; speaker++) {
    const positive = scores.filter((row) => (row[speaker] ?? 0) > 0).length
    if (positive < minPositive) continue
    for (const row of scores) {
      const score = row[speaker] ?? -Infinity
      if (score !== -Infinity && score <= 0) row[speaker] = -Infinity
    }
  }
  return scores
}

/** Raises each speaker's best `count` frames, so everyone keeps a share of the cache. */
function boostBest(scores: number[][], speakers: number, count: number, by: number): void {
  for (let speaker = 0; speaker < speakers; speaker++) {
    const best = scores
      .map((row, frame) => ({ frame, score: row[speaker] ?? -Infinity }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
    for (const { frame } of best) {
      const row = scores[frame]
      if (row) row[speaker] = (row[speaker] ?? -Infinity) + by
    }
  }
}

/**
 * Keeps the `cacheFrames` frames that matter most, grouped by speaker and in their original order
 * within a speaker, with one slot of the model's silence frame per speaker. Slots nobody earned
 * hold the silence frame too.
 */
export function compress(
  frames: readonly Frame[],
  probabilities: readonly Frame[],
  silence: Frame,
  policy: CachePolicy
): { frames: Frame[]; probabilities: Frame[] } {
  const { speakers, cacheFrames } = policy
  const budget = Math.floor(cacheFrames / speakers) - 1
  const scores = frameScores(probabilities, speakers, Math.floor(budget * 0.5))
  for (const row of scores.slice(cacheFrames)) for (let s = 0; s < speakers; s++) row[s] = (row[s] ?? -Infinity) + LATEST_BOOST
  boostBest(scores, speakers, Math.floor(budget * 0.75), -2 * LOG_HALF)
  boostBest(scores, speakers, Math.floor(budget * 1.5), -LOG_HALF)

  // Every (speaker, frame) pair competes; a speaker's silence slot always wins a place.
  const count = frames.length
  const candidates: { speaker: number; frame: number; score: number }[] = []
  for (let speaker = 0; speaker < speakers; speaker++) {
    scores.forEach((row, frame) => candidates.push({ speaker, frame, score: row[speaker] ?? -Infinity }))
    candidates.push({ speaker, frame: count, score: Infinity })
  }
  const kept = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, cacheFrames)
    // Unearned slots sort after every speaker's frames.
    .map((pick) => (pick.score === -Infinity ? { speaker: speakers, frame: count } : pick))
    .sort((a, b) => a.speaker - b.speaker || a.frame - b.frame)
  const quiet = new Float32Array(speakers)
  return {
    frames: kept.map(({ frame }) => frames[frame] ?? silence),
    probabilities: kept.map(({ frame }) => probabilities[frame] ?? quiet)
  }
}

export type SpeakerCache = {
  /** The frames every chunk is read with: the cache, then the queue. */
  frames: () => Frame[]
  /**
   * Takes in a chunk the model has just read. `input` is every frame the model saw (the cache,
   * the queue, the chunk, and any look-ahead after it) and `probabilities` what it made of each;
   * only the `chunkFrames` after the cache and queue are new.
   */
  update: (input: readonly Frame[], probabilities: readonly Frame[], silence: Frame, chunkFrames: number) => void
}

export function speakerCache(policy: CachePolicy = WHOLE_RECORDING): SpeakerCache {
  let cached: Frame[] = []
  let cachedProbabilities: Frame[] = []
  let queue: Frame[] = []
  // Once compressed the cache is out of time order, so the model's fresh reading of it no longer
  // lines up with it and the probabilities stored beside the frames are the ones to use.
  let compressed = false
  return {
    frames: () => [...cached, ...queue],
    update(input, probabilities, silence, chunkFrames) {
      const chunkStart = cached.length + queue.length
      const waiting = [...queue, ...input.slice(chunkStart, chunkStart + chunkFrames)]
      const moved =
        waiting.length <= policy.queueFrames
          ? 0
          : Math.min(Math.max(policy.updateFrames, waiting.length - policy.queueFrames), waiting.length)
      if (moved > 0) {
        const waitingProbabilities = probabilities.slice(cached.length, chunkStart + chunkFrames)
        const known = compressed ? cachedProbabilities : probabilities.slice(0, cached.length)
        cached = [...cached, ...waiting.slice(0, moved)]
        cachedProbabilities = [...known, ...waitingProbabilities.slice(0, moved)]
        if (cached.length > policy.cacheFrames) {
          const next = compress(cached, cachedProbabilities, silence, policy)
          cached = next.frames
          cachedProbabilities = next.probabilities
          compressed = true
        }
      }
      queue = waiting.slice(moved)
    }
  }
}

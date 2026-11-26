/**
 * How long finding who spoke when should take. Diarization can't report its own progress, but it
 * runs at a steady rate per second of audio on a given machine, so the last runs predict the next.
 */

/**
 * Seconds of work per second of audio before Lyra has timed a run on this machine. Real sessions
 * took 0.07–0.12 on a laptop with a recent CPU; starting at the slow end means the first estimate
 * errs long, which reads better than one that runs out.
 */
export const DEFAULT_RATE = 0.12
/** Fixed cost of a run whatever its length: loading the models and naming the voices. */
export const OVERHEAD_MS = 3_000
/** Weight of the latest run in the learned rate: recent runs count most, one odd run can't swing it. */
const LEARN_WEIGHT = 0.5
/** Runs shorter than this are mostly overhead and say little about the rate. */
const MIN_LEARN_SECONDS = 30

/** Expected milliseconds to diarize `audioSeconds` of audio at `rate`. */
export function expectedMs(audioSeconds: number, rate: number): number {
  return Math.round(OVERHEAD_MS + Math.max(0, audioSeconds) * rate * 1000)
}

/** The rate after a run of `audioSeconds` took `tookMs`; short runs leave it as it was. */
export function learnRate(rate: number, audioSeconds: number, tookMs: number): number {
  if (audioSeconds < MIN_LEARN_SECONDS || tookMs <= 0) return rate
  const observed = Math.max(0, tookMs - OVERHEAD_MS) / 1000 / audioSeconds
  return rate * (1 - LEARN_WEIGHT) + observed * LEARN_WEIGHT
}

let rate = DEFAULT_RATE

/** Starts timing a run over `audioSeconds` of audio: its estimate, and a call for when it ends. */
export function startEstimate(audioSeconds: number): {
  estimate: { startedAt: number; expectedMs: number }
  finish: () => void
} {
  const startedAt = Date.now()
  return {
    estimate: { startedAt, expectedMs: expectedMs(audioSeconds, rate) },
    finish: () => {
      rate = learnRate(rate, audioSeconds, Date.now() - startedAt)
    }
  }
}

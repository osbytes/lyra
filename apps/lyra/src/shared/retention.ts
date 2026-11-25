/**
 * "Keep audio" rules shared by the sweep in main and the Settings confirmation. Days are the
 * `audioRetentionDays` setting: `null` keeps audio forever, `0` deletes it once transcribed.
 */

const DAY_MS = 86_400_000

/**
 * Whether going from `prev` to `next` can delete audio that `prev` kept. Forever is the loosest;
 * `0` is the strictest.
 */
export function isStricterRetention(prev: number | null, next: number | null): boolean {
  if (next === null) return false
  if (prev === null) return true
  return next < prev
}

/**
 * Audio that ended before this time (epoch ms) is expired, or null when the sweep deletes
 * nothing: forever keeps everything, and `0` is handled per session as it is transcribed.
 */
export function retentionCutoff(days: number | null, now: number): number | null {
  if (days === null || days === 0) return null
  return now - days * DAY_MS
}

/** Whether a session whose audio ended at `endedAt` (ISO) is past `cutoff`. */
export function audioExpired(endedAt: string, cutoff: number): boolean {
  const ended = Date.parse(endedAt)
  return Number.isFinite(ended) && ended < cutoff
}

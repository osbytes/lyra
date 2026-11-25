/**
 * On a call, whether a mic chunk is only the far end's echo and should not go to Whisper. No
 * Electron here, so the rule is unit-tested on its own.
 */

/**
 * A mic chunk with less of the user's own speech than this, while the far end was talking, is
 * what slipped past the echo gate: Whisper would invent words for it ("Hello? Hello?").
 */
export const MIN_OWN_SECONDS = 0.4

/**
 * How much far-end sound a chunk needs before it can be an echo at all. With the far end silent
 * there is nothing to echo, so a quick "Yes." on the mic is the user and is kept. A tenth of a
 * second (three frames) so a click or a notification blip doesn't count as the far end talking.
 */
export const MIN_FAR_ACTIVE_SECONDS = 0.1

/**
 * Echo reaches the mic after the far end plays it (speaker, room, capture buffers), so far-end
 * sound this long before a chunk starts still counts toward it. The echo gate looks back over
 * ten 32 ms frames for the same reason.
 */
export const ECHO_LEAD_SECONDS = 0.32

/** Raw system-track level above which the far end is playing something (the echo gate's bar). */
export const FAR_ACTIVE_RMS = 0.004

export function isEchoOnly(ownSeconds: number, farActiveSeconds: number): boolean {
  return farActiveSeconds >= MIN_FAR_ACTIVE_SECONDS && ownSeconds < MIN_OWN_SECONDS
}

/** How many of the ascending `starts` fall in [from, to). */
export function countBetween(starts: readonly number[], from: number, to: number): number {
  let count = 0
  for (const at of starts) {
    if (at >= to) break
    if (at >= from) count++
  }
  return count
}

/** Axis steps, in seconds, from fine to coarse. */
const STEPS = [60, 120, 300, 600, 900, 1800, 3600]

/**
 * The speaker timeline's axis step for a session `end` seconds long: the finest step that gives
 * at most six marks, so labels never crowd (2 min for a 10 minute call, 15 min for an hour).
 */
export function axisStep(end: number): number {
  return STEPS.find((step) => end / step <= 6) ?? STEPS[STEPS.length - 1] ?? 3600
}

/**
 * The line being spoken at `seconds`, from lines in start order: the last one that started by
 * then, if it hasn't ended yet. Null in a pause.
 */
export function lineAt<T extends { start: number; end: number }>(lines: readonly T[], seconds: number): T | null {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const line = lines[mid]
    if (line && line.start <= seconds) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  const line = found >= 0 ? lines[found] : undefined
  return line && seconds <= line.end ? line : null
}

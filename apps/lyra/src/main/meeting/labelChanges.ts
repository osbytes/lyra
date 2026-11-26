/**
 * How much the speaker labels a reader saw were changed under them: the cost of labeling while
 * recording that accuracy at the end doesn't show. A line that said one speaker and says another
 * after a round (or after the pass once the recording stops) was read wrong for a while, or
 * flickered. Counted in seconds of transcript, so evals and the log can track it.
 */

type Labeled = { start: number; end: number; cluster: string | null }

/**
 * `labeled`: seconds of `before` that showed a speaker. `changed`: seconds of those that show
 * another speaker, or none, in `after`. Lines are compared by time, not id: a pass rebuilds the
 * lines, so the same words can sit in a different line with the same speaker (no change).
 */
export function changedLabels(
  before: readonly Labeled[],
  after: readonly Labeled[]
): { labeled: number; changed: number } {
  let labeled = 0
  let changed = 0
  for (const old of before) {
    if (old.cluster === null) continue
    labeled += Math.max(0, old.end - old.start)
    for (const now of after) {
      if (now.cluster === old.cluster) continue
      changed += Math.max(0, Math.min(old.end, now.end) - Math.max(old.start, now.start))
    }
  }
  return { labeled, changed }
}

/** A session's labels so far: what the rounds while recording changed, and the pass at the stop. */
export type LabelStability = {
  rounds: number
  /** Seconds of labeled transcript a later round gave another speaker, summed over rounds. */
  changedWhileRecording: number
  /** Seconds that showed a speaker when the recording stopped… */
  labeledAtStop: number
  /** …and of those, the seconds the pass after the stop gave another speaker. */
  changedAtStop: number
}

const tallies = new Map<string, LabelStability>()

function tally(pageId: string): LabelStability {
  const found = tallies.get(pageId)
  if (found) return found
  const fresh = { rounds: 0, changedWhileRecording: 0, labeledAtStop: 0, changedAtStop: 0 }
  tallies.set(pageId, fresh)
  return fresh
}

/** A round while recording changed `changed` seconds of labels. */
export function noteRound(pageId: string, changed: number): void {
  const entry = tally(pageId)
  entry.rounds++
  entry.changedWhileRecording += changed
}

/** The pass after the stop found `labeled` seconds of labels and changed `changed` of them. */
export function noteSettled(pageId: string, labeled: number, changed: number): void {
  const entry = tally(pageId)
  entry.labeledAtStop = labeled
  entry.changedAtStop = changed
}

/** Since the app started; evals read it once a replay is done. */
export function labelStability(pageId: string): LabelStability {
  return { ...tally(pageId) }
}

// Compares an eval run with a stored baseline, so a change that makes speakers or transcription
// worse fails loudly instead of sitting unread in a table (`run-eval.cjs --check`).
//
// A baseline keeps each item's rates and the pooled ones. Rates move a little from run to run
// without any change in Lyra (chunk boundaries alone shift a session by a point or two), so a
// regression is a rise past a tolerance: a small one on the pooled rates, a wider one per item.

/** Rates that must not rise. `relabeled` is the share of live labels the last pass changed. */
const RATES = ['wer', 'cpWer', 'der', 'relabeled']
const DEFAULT_TOLERANCE = { overall: 0.02, item: 0.06 }

const round = (value) => +value.toFixed(4)

/** What a baseline keeps of a run's results.json. */
function summarize(run) {
  const items = {}
  for (const result of run.results) {
    items[result.id] = {
      wer: round(result.wer.rate),
      cpWer: round(result.cpWer.rate),
      der: round(result.der.rate),
      ...(result.labels && result.labels.labeledAtStop > 0
        ? { relabeled: round(result.labels.changedAtStop / result.labels.labeledAtStop) }
        : {}),
      speakers: `${result.hypSpeakers}/${result.refSpeakers}`
    }
  }
  const overall = { wer: round(run.overall.wer), cpWer: round(run.overall.cpWer), der: round(run.overall.der) }
  if (run.overall.relabeled !== undefined) overall.relabeled = round(run.overall.relabeled)
  return { dataset: run.dataset, pipeline: run.pipeline, overall, items }
}

/**
 * Where `current` is worse than `baseline` by more than the tolerance, and what is missing.
 * Both are summaries. An item only in `current` is new and passes; one only in `baseline` did
 * not run (it failed, or the suite changed) and fails, so a baseline can't quietly shrink.
 */
function compare(baseline, current, tolerance = DEFAULT_TOLERANCE) {
  const regressions = []
  const check = (id, before, after, limit) => {
    for (const rate of RATES) {
      if (before[rate] === undefined || after[rate] === undefined) continue
      const delta = after[rate] - before[rate]
      if (delta > limit + 1e-9) regressions.push({ id, rate, before: before[rate], after: after[rate], delta: round(delta) })
    }
  }
  check('overall', baseline.overall, current.overall, tolerance.overall)
  const missing = []
  for (const [id, before] of Object.entries(baseline.items)) {
    const after = current.items[id]
    if (!after) missing.push(id)
    else check(id, before, after, tolerance.item)
  }
  return { regressions, missing, ok: regressions.length === 0 && missing.length === 0 }
}

module.exports = { DEFAULT_TOLERANCE, compare, summarize }

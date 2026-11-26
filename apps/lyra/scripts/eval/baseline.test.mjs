import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { compare, summarize } = require('./baseline.cjs')

const result = (id, wer, cpWer, der, labels) => ({
  id,
  hypSpeakers: 2,
  refSpeakers: 2,
  wer: { rate: wer },
  cpWer: { rate: cpWer },
  der: { rate: der },
  ...(labels ? { labels } : {})
})

describe('summarize', () => {
  it('keeps each item and the pooled rates, and the share of live labels the last pass changed', () => {
    const run = {
      dataset: 'sessions',
      pipeline: 'live',
      overall: { wer: 0.1, cpWer: 0.2, der: 0.05, relabeled: 0.1 },
      results: [
        result('a', 0.1, 0.2, 0.05, { rounds: 3, changedWhileRecording: 1, labeledAtStop: 50, changedAtStop: 5 }),
        result('b', 0.3, 0.3, 0.1)
      ]
    }
    expect(summarize(run)).toEqual({
      dataset: 'sessions',
      pipeline: 'live',
      overall: { wer: 0.1, cpWer: 0.2, der: 0.05, relabeled: 0.1 },
      items: {
        // 5 of 50 labeled seconds changed.
        a: { wer: 0.1, cpWer: 0.2, der: 0.05, relabeled: 0.1, speakers: '2/2' },
        b: { wer: 0.3, cpWer: 0.3, der: 0.1, speakers: '2/2' }
      }
    })
  })
})

describe('compare', () => {
  const summary = (overall, items) => ({ dataset: 'sessions', pipeline: 'live', overall, items })
  const base = summary(
    { wer: 0.2, cpWer: 0.25, der: 0.09 },
    { a: { wer: 0.1, cpWer: 0.15, der: 0.05 }, b: { wer: 0.3, cpWer: 0.35, der: 0.13 } }
  )

  it('passes a run within the tolerance, better or a little worse', () => {
    const run = summary(
      { wer: 0.21, cpWer: 0.2, der: 0.1 },
      { a: { wer: 0.15, cpWer: 0.1, der: 0.05 }, b: { wer: 0.3, cpWer: 0.4, der: 0.13 }, c: { wer: 0.9, cpWer: 0.9, der: 0.9 } }
    )
    expect(compare(base, run)).toEqual({ regressions: [], missing: [], ok: true })
  })

  it('fails a pooled rate that rose past 2 points and an item past 6', () => {
    const run = summary(
      { wer: 0.2, cpWer: 0.28, der: 0.09 },
      { a: { wer: 0.1, cpWer: 0.15, der: 0.12 }, b: { wer: 0.3, cpWer: 0.35, der: 0.13 } }
    )
    const { regressions, ok } = compare(base, run)
    expect(ok).toBe(false)
    expect(regressions).toEqual([
      { id: 'overall', rate: 'cpWer', before: 0.25, after: 0.28, delta: 0.03 },
      { id: 'a', rate: 'der', before: 0.05, after: 0.12, delta: 0.07 }
    ])
  })

  it('fails when an item of the baseline did not run', () => {
    const run = summary({ wer: 0.2, cpWer: 0.25, der: 0.09 }, { a: base.items.a })
    expect(compare(base, run)).toMatchObject({ missing: ['b'], ok: false })
  })
})

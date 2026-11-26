import { describe, expect, it } from 'vitest'
import { changedLabels, labelStability, noteRound, noteSettled } from './labelChanges'

const line = (start: number, end: number, cluster: string | null) => ({ start, end, cluster })

describe('changedLabels', () => {
  it('counts the seconds of labeled lines that now show another speaker', () => {
    const before = [line(0, 10, 'c0'), line(10, 20, 'c1'), line(20, 30, null)]
    // The first line is split: 0–6 keeps c0, 6–10 goes to c1. The second keeps c1 in new lines.
    const after = [line(0, 6, 'c0'), line(6, 14, 'c1'), line(14, 20, 'c1'), line(20, 30, 'c0')]
    // 20 s were labeled (the unlabeled line doesn't count); 4 s of c0 became c1.
    expect(changedLabels(before, after)).toEqual({ labeled: 20, changed: 4 })
  })

  it('counts a label that was taken away, and nothing where the lines only moved', () => {
    expect(changedLabels([line(0, 10, 'c0')], [line(0, 4, 'c0'), line(4, 10, null)])).toEqual({ labeled: 10, changed: 6 })
    expect(changedLabels([line(0, 10, 'c0')], [line(0, 3, 'c0'), line(3.5, 10, 'c0')])).toEqual({ labeled: 10, changed: 0 })
    expect(changedLabels([], [line(0, 3, 'c0')])).toEqual({ labeled: 0, changed: 0 })
  })
})

describe('the tally', () => {
  it('adds up rounds and keeps the pass at the stop', () => {
    noteRound('tally-test', 1.5)
    noteRound('tally-test', 0)
    noteRound('tally-test', 2)
    noteSettled('tally-test', 60, 3)
    expect(labelStability('tally-test')).toEqual({
      rounds: 3,
      changedWhileRecording: 3.5,
      labeledAtStop: 60,
      changedAtStop: 3
    })
    expect(labelStability('tally-other').rounds).toBe(0)
  })
})

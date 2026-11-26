import { describe, expect, it } from 'vitest'
import { refineEdges, snapTurns } from './turnEdges'

describe('refineEdges', () => {
  // Speaker 0 really talks until 6.5 s, speaker 1 after; a voiceprint of a stretch is the mix
  // of the two by how much of each it holds.
  const change = 6.5
  const embed = (start: number, end: number): number[] => {
    const first = Math.max(0, Math.min(end, change) - start)
    const second = Math.max(0, end - Math.max(start, change))
    const length = Math.hypot(first, second) || 1
    return [first / length, second / length]
  }
  const centres = new Map([
    [0, [1, 0]],
    [1, [0, 1]]
  ])

  it('moves a change to where each side sounds like its own speaker', () => {
    const turns = [
      { start: 0, end: 5.5, speaker: 0 },
      { start: 5.5, end: 12, speaker: 1 }
    ]
    // Candidates run 4, 4.25, … 7: at 6.5 the two seconds before are all speaker 0 and the two
    // after all speaker 1, which no other point matches.
    expect(refineEdges(turns, centres, embed)).toEqual([
      { start: 0, end: 6.5, speaker: 0 },
      { start: 6.5, end: 12, speaker: 1 }
    ])
  })

  it('leaves a change at a pause, between tracks, or between turns of one speaker', () => {
    const paused = [
      { start: 0, end: 5.5, speaker: 0 },
      { start: 6.2, end: 12, speaker: 1 }
    ]
    expect(refineEdges(paused, centres, embed)).toEqual(paused)
    const touching = [
      { start: 0, end: 5.5, speaker: 0 },
      { start: 5.5, end: 12, speaker: 1 }
    ]
    expect(refineEdges(touching, centres, embed, () => false)).toEqual(touching)
    const same = [
      { start: 0, end: 5.5, speaker: 0 },
      { start: 5.5, end: 12, speaker: 0 }
    ]
    expect(refineEdges(same, centres, embed)).toEqual(same)
  })

  it('keeps half a second of a short turn', () => {
    const turns = [
      { start: 6, end: 7, speaker: 0 },
      { start: 7, end: 12, speaker: 1 }
    ]
    // The true change (6.5) is the earliest point allowed: 6 + 0.5.
    expect(refineEdges(turns, centres, embed)[0]).toEqual({ start: 6, end: 6.5, speaker: 0 })
  })
})

describe('snapTurns', () => {
  const word = (text: string, start: number, end: number, track: 'mic' | 'system' = 'mic') => ({ text, start, end, track })

  it('moves a change back to the sentence end and pause just before it', () => {
    const words = [
      word(' We', 0, 0.2),
      word(' agree.', 0.2, 0.6),
      // The reply starts after a pause; diarization put its first word with the speaker before.
      word(' Yes', 1.1, 1.3),
      word(' I', 1.35, 1.4),
      word(' think', 1.4, 1.7)
    ]
    // Cut after "agree.": pause 0.5 + sentence end 0.3 − one word 0.05 = 0.75, the best around.
    expect(snapTurns(words, [0, 0, 0, 1, 1])).toEqual([0, 0, 1, 1, 1])
  })

  it('moves a change forward to the pause just after it', () => {
    const words = [word(' so', 0, 0.2), word(' that', 0.25, 0.5), word(' is', 0.55, 0.7), word(' Right', 1.3, 1.6), word(' then', 1.65, 1.9)]
    // The change sits before "is"; the pause is after it (0.6 − 0.05 for one word).
    expect(snapTurns(words, [0, 0, 1, 1, 1])).toEqual([0, 0, 0, 1, 1])
  })

  it('stays put with no pause or sentence end in reach, or with one too far away', () => {
    const run = [word(' a', 0, 0.3), word(' b', 0.3, 0.6), word(' c', 0.6, 0.9), word(' d', 0.9, 1.2)]
    expect(snapTurns(run, [0, 0, 1, 1])).toEqual([0, 0, 1, 1])
    const far = [word(' a.', 0, 0.3), word(' b', 2.0, 2.6), word(' c', 2.6, 3.2), word(' d', 3.2, 3.8), word(' e', 3.8, 4.4)]
    // The change after "c" ends at 3.2; the pause after "a." ended a turn 2.9 s earlier.
    expect(snapTurns(far, [0, 0, 0, 1, 1])).toEqual([0, 0, 0, 1, 1])
  })

  it('never moves words the user fixed, words of another track, or a third speaker', () => {
    const words = [word(' We', 0, 0.2), word(' agree.', 0.2, 0.6), word(' Yes', 1.1, 1.3), word(' I', 1.35, 1.4)]
    expect(snapTurns(words, [0, 0, 0, 1], [false, false, true, false])).toEqual([0, 0, 0, 1])
    const tracks = [word(' We', 0, 0.2), word(' agree.', 0.2, 0.6), word(' Yes', 1.1, 1.3, 'system'), word(' I', 1.35, 1.4, 'system')]
    expect(snapTurns(tracks, [0, 0, 1, 1])).toEqual([0, 0, 1, 1])
    // The word before the pause belongs to a third speaker's turn: not this change's to move.
    const third = [word(' We', 0, 0.2), word(' agree.', 0.2, 0.6), word(' Yes', 1.1, 1.3), word(' I', 1.35, 1.4)]
    expect(snapTurns(third, [2, 2, 0, 1])).toEqual([2, 2, 0, 1])
  })
})

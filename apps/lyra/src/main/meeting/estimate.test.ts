import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE, expectedMs, learnRate, OVERHEAD_MS } from './estimate'

describe('expectedMs', () => {
  it('adds the fixed overhead to the audio at the rate', () => {
    // 10 minutes at 0.1 s per second: 60 s, plus 3 s overhead.
    expect(expectedMs(600, 0.1)).toBe(63_000)
  })

  it('is just the overhead for no audio', () => {
    expect(expectedMs(0, DEFAULT_RATE)).toBe(OVERHEAD_MS)
  })
})

describe('learnRate', () => {
  it('moves halfway to the rate a run showed', () => {
    // 1000 s of audio in 53 s: 50 s of work past the overhead, 0.05 per second.
    expect(learnRate(0.15, 1000, 53_000)).toBeCloseTo(0.1)
  })

  it('ignores runs too short to say much', () => {
    expect(learnRate(0.12, 10, 9_000)).toBe(0.12)
  })
})

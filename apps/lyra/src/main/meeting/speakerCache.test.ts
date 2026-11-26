import { describe, expect, it } from 'vitest'
import { compress, speakerCache, type CachePolicy } from './speakerCache'

const policy: CachePolicy = { speakers: 2, cacheFrames: 4, queueFrames: 2, updateFrames: 3 }
/** A frame that can be told from the others, and what the model made of it. */
const frame = (id: number): Float32Array => Float32Array.of(id)
const said = (first: number, second: number): Float32Array => Float32Array.of(first, second)
const ids = (frames: readonly Float32Array[]): number[] => frames.map((f) => f[0] ?? -1)

describe('speakerCache', () => {
  it('queues a short chunk whole, and moves the oldest frames to the cache when it overflows', () => {
    const cache = speakerCache(policy)
    cache.update([frame(1), frame(2)], [said(0.9, 0), said(0.9, 0)], frame(0), 2)
    expect(ids(cache.frames())).toEqual([1, 2])
    // Two more make four waiting: over the queue's two, so at least three move (frames 1-3).
    const seen = [...cache.frames(), frame(3), frame(4), frame(99)]
    cache.update(seen, seen.map(() => said(0.9, 0)), frame(0), 2)
    expect(ids(cache.frames())).toEqual([1, 2, 3, 4])
  })

  it('leaves look-ahead frames out: they come again with the next chunk', () => {
    const cache = speakerCache(policy)
    cache.update([frame(1), frame(2)], [said(0.9, 0), said(0.9, 0)], frame(0), 1)
    expect(ids(cache.frames())).toEqual([1])
  })
})

describe('compress', () => {
  it('keeps each speaker’s frames together in arrival order, with a silence slot each', () => {
    // Six frames for a cache of four. Speaker 0 alone in 1 and 2, speaker 1 alone in 3 and 4,
    // both at once in 5, nobody in 6. Each speaker has one silence slot, which always wins a
    // place, leaving two: the budget (4 / 2 - 1 = 1 frame each) boosts each speaker's best
    // frame. Frames 5 and 6 arrive last and are preferred a little, but 5 is shared and 6 is
    // nobody's, so the latest clean frame of each speaker is kept: 2 and 4.
    const frames = [1, 2, 3, 4, 5, 6].map(frame)
    const probabilities = [said(0.9, 0), said(0.9, 0), said(0, 0.9), said(0, 0.9), said(0.9, 0.9), said(0, 0)]
    const kept = compress(frames, probabilities, frame(0), policy)
    expect(ids(kept.frames)).toEqual([1, 0, 3, 0])
    expect(kept.probabilities.map((p) => Array.from(p))).toEqual([
      [expect.closeTo(0.9, 5), 0],
      [0, 0],
      [0, expect.closeTo(0.9, 5)],
      [0, 0]
    ])
  })
})

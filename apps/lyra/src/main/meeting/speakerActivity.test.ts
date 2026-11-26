import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_HIDDEN,
  ACTIVITY_SPEAKERS,
  activityTurns,
  readActivity,
  withoutEchoes,
  withoutFaintSpeakers,
  type Activity,
  type ActivityStep
} from './speakerActivity'

/** Probabilities for `frames` 10 ms frames; `speaking(frame)` lists who is talking in each. */
function activity(frames: number, speaking: (frame: number) => number[]): Activity {
  const probabilities = new Float32Array(frames * ACTIVITY_SPEAKERS)
  for (let frame = 0; frame < frames; frame++) {
    for (const speaker of speaking(frame)) probabilities[frame * ACTIVITY_SPEAKERS + speaker] = 0.9
  }
  return { probabilities, frames }
}

describe('activityTurns', () => {
  it('turns runs of frames into turns, closing a breath and dropping a click', () => {
    // Speaker 0: 0-1 s and 1.3-2 s (a 0.3 s pause, closed). Speaker 1: 2.5-2.6 s (0.1 s, dropped)
    // and 4-5 s.
    const turns = activityTurns(
      activity(600, (frame) => [
        ...(frame < 100 || (frame >= 130 && frame < 200) ? [0] : []),
        ...((frame >= 250 && frame < 260) || (frame >= 400 && frame < 500) ? [1] : [])
      ])
    )
    expect(turns).toEqual([
      { start: 0, end: 2, speaker: 0 },
      { start: 4, end: 5, speaker: 1 }
    ])
  })

  it('keeps two people talking at once as overlapping turns', () => {
    const turns = activityTurns(activity(300, (frame) => [...(frame < 200 ? [0] : []), ...(frame >= 100 ? [2] : [])]))
    expect(turns).toEqual([
      { start: 0, end: 2, speaker: 0 },
      { start: 1, end: 3, speaker: 2 }
    ])
  })
})

describe('withoutEchoes', () => {
  it('joins a channel that speaks along with another for most of its speech', () => {
    // Speaker 1 is active for 9 s, 8 of them inside speaker 0's turns: 8 / 9 = 0.89 of its speech.
    const turns = [
      { start: 0, end: 10, speaker: 0 },
      { start: 1, end: 9, speaker: 1 },
      { start: 10, end: 11, speaker: 1 },
      { start: 12, end: 20, speaker: 2 }
    ]
    expect(withoutEchoes(turns)).toEqual([
      { start: 0, end: 11, speaker: 0 },
      { start: 12, end: 20, speaker: 2 }
    ])
  })

  it('leaves two people who talk over each other now and then', () => {
    // 2 s together of speaker 1's 10 s: 0.2.
    const turns = [
      { start: 0, end: 10, speaker: 0 },
      { start: 8, end: 18, speaker: 1 }
    ]
    expect(withoutEchoes(turns)).toEqual(turns)
  })
})

describe('withoutFaintSpeakers', () => {
  const turns = [
    { start: 0, end: 10, speaker: 0 },
    { start: 10, end: 11, speaker: 1 },
    { start: 11, end: 20, speaker: 0 }
  ]

  it('drops a speaker heard for less than the bar', () => {
    expect(withoutFaintSpeakers(turns, 3, null, 5).map((turn) => turn.speaker)).toEqual([0, 0])
    expect(withoutFaintSpeakers(turns, 1, null, 5)).toHaveLength(3)
  })

  it('keeps a brief speaker who has words of their own', () => {
    const words = [10.0, 10.2, 10.4, 10.6, 10.8].map((start) => ({ start, end: start + 0.15 }))
    expect(withoutFaintSpeakers(turns, 3, words, 5)).toHaveLength(3)
    expect(withoutFaintSpeakers(turns, 3, words.slice(0, 4), 5)).toHaveLength(2)
  })
})

describe('readActivity', () => {
  it('feeds a recording through in chunks with the cached frames, and keeps each chunk’s own answer', async () => {
    // 60 s of audio: 6001 feature frames, 751 model frames, so three steps (340, 340, 71).
    const steps: { featureFrames: number; cached: number }[] = []
    const run = (step: ActivityStep) => {
      steps.push({ featureFrames: step.featureFrames, cached: step.cached.length })
      const frames = step.cached.length + Math.ceil(step.featureFrames / 8)
      // Speaker 0 in every cached frame, speaker 1 in every new one.
      const logits = new Float32Array(frames * 8 * ACTIVITY_SPEAKERS).fill(-10)
      for (let i = 0; i < frames * 8; i++) logits[i * ACTIVITY_SPEAKERS + (i < step.cached.length * 8 ? 0 : 1)] = 10
      return Promise.resolve({
        logits,
        frames: new Float32Array(Math.ceil(step.featureFrames / 8) * ACTIVITY_HIDDEN),
        silence: new Float32Array(ACTIVITY_HIDDEN)
      })
    }
    const result = await readActivity(new Float32Array(60 * 16000), run)
    expect(result.frames).toBe(6001)
    // The first two steps see their 340 frames and 40 ahead; the last sees what is left, short
    // of the 7 feature frames its final stack of 8 lacks. Nothing is cached at first. After a
    // step the queue keeps the latest 40 frames and the cache, over full, is cut to its 264.
    expect(steps).toEqual([
      { featureFrames: 380 * 8, cached: 0 },
      { featureFrames: 380 * 8, cached: 304 },
      { featureFrames: 71 * 8 - 7, cached: 304 }
    ])
    // Only the new frames' answers are kept: speaker 1 everywhere, speaker 0 nowhere.
    const turns = activityTurns(result)
    expect(turns).toEqual([{ start: 0, end: 60.01, speaker: 1 }])
  })
})

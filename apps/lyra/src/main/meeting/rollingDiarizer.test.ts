import { describe, expect, it } from 'vitest'
import { advance, emptyRolling, rollingResult, type RollingTools } from './rollingDiarizer'

const RATE = 100

/** `seconds` of audio that is silent except where a voice speaks: +0.5 for one, -0.5 for another. */
function track(seconds: number, turns: readonly [voice: 'a' | 'b', start: number, end: number][], from = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (const [voice, start, end] of turns) {
    for (let i = Math.round((start - from) * RATE); i < Math.round((end - from) * RATE); i++) {
      if (i >= 0 && i < out.length) out[i] = voice === 'a' ? 0.5 : -0.5
    }
  }
  return out
}

let embedded = 0
const tools: RollingTools = {
  sampleRate: RATE,
  windowSeconds: 3,
  minWindowSeconds: 1,
  // Speech is wherever the audio isn't silent; a new piece where the voice changes.
  segment: (audio) => {
    const pieces: { start: number; end: number }[] = []
    let start = -1
    for (let i = 0; i <= audio.length; i++) {
      const value = audio[i] ?? 0
      const previous = audio[i - 1] ?? 0
      if (start !== -1 && (value === 0 || value !== previous)) {
        pieces.push({ start: start / RATE, end: i / RATE })
        start = -1
      }
      if (start === -1 && value !== 0) start = i
    }
    return pieces
  },
  embed: (samples) => {
    embedded++
    return (samples[0] ?? 0) > 0 ? [2, 0] : [0, 2]
  }
}

const options = { threshold: 0.3, minWindowSeconds: 1, minOwnWords: 5, hasSystem: false, words: null }
const spans = (segments: readonly { speaker: number; start: number; end: number }[]): [number, number, number][] =>
  segments.map(({ speaker, start, end }) => [speaker, +start.toFixed(1), +end.toFixed(1)])

describe('advance', () => {
  it('settles all but the last seconds, and only works on new audio the next round', () => {
    // A 1–7 s, B 9–14.5 s, A again from 16 s, still talking when the first round ends at 20 s.
    const turns: [voice: 'a' | 'b', start: number, end: number][] = [
      ['a', 1, 7],
      ['b', 9, 14.5],
      ['a', 16, 22]
    ]
    embedded = 0
    const first = advance(emptyRolling(), { mic: track(20, turns), system: null }, tools)
    // 20 s of audio less the 5 s tail.
    expect(first.state.doneTo).toBe(15)
    // 6 s of A is windows at 1, 2.5 and 4 s; 5.5 s of B is windows at 9, 10.5 and 12 s.
    expect(first.state.windows.map((window) => window.start)).toEqual([1, 2.5, 4, 9, 10.5, 12])
    expect(first.state.prints[0]).toEqual([1, 0])
    expect(first.state.prints[3]).toEqual([0, 1])
    expect(first.state.micEnergy).toHaveLength(150)
    expect(first.tail.windows).toEqual([{ start: 16, end: 20 }])
    expect(first.tail.end).toBe(20)
    expect(embedded).toBe(7)

    // The next round gets the audio from 15 s on, and takes voiceprints of that alone.
    embedded = 0
    const second = advance(first.state, { mic: track(15, turns, 15), system: null }, tools)
    expect(second.state.doneTo).toBe(25)
    // A's 16–22 s is now settled: 6 s, so windows at 16, 17.5 and 19 s.
    expect(second.state.windows.map((window) => window.start)).toEqual([1, 2.5, 4, 9, 10.5, 12, 16, 17.5, 19])
    expect(second.tail.windows).toEqual([])
    expect(embedded).toBe(3)

    const result = rollingResult(second.state, second.tail, options)
    expect(result.seconds).toBe(30)
    expect(spans(result.segments)).toEqual([
      [0, 1, 7],
      [1, 9, 14.5],
      [0, 16, 22]
    ])
    expect(result.clusters).toEqual([
      { speaker: 0, embedding: [1, 0] },
      { speaker: 1, embedding: [0, 1] }
    ])
  })

  it('cuts a piece of speech that crosses the settled line, and finds the rest again', () => {
    // One voice from 2 s to past the end of a 12 s round: settled to 7 s, so 2–7 s is kept.
    const turns: [voice: 'a' | 'b', start: number, end: number][] = [['a', 2, 16]]
    const first = advance(emptyRolling(), { mic: track(12, turns), system: null }, tools)
    expect(first.state.doneTo).toBe(7)
    // 5 s is over one and a half windows: windows at 2, 3.5 and 5 s, the last up to the cut.
    expect(first.state.windows).toEqual([
      { start: 2, end: 5 },
      { start: 3.5, end: 6.5 },
      { start: 5, end: 7 }
    ])
    expect(first.tail.windows[0]).toEqual({ start: 7, end: 10 })
    const result = rollingResult(first.state, first.tail, options)
    expect(spans(result.segments)).toEqual([[0, 2, 12]])
  })
})

describe('rollingResult', () => {
  it('knows which track each speaker was on from the energy kept per block', () => {
    const mic = track(20, [['a', 1, 7]])
    const system = track(20, [['b', 8, 14]])
    const { state, tail } = advance(emptyRolling(), { mic, system }, tools)
    const result = rollingResult(state, tail, { ...options, hasSystem: true })
    expect(result.segments.map(({ speaker, micShare }) => [speaker, micShare])).toEqual([
      [0, 1],
      [1, 0]
    ])
  })

  it('has nobody before anyone has spoken', () => {
    const { state, tail } = advance(emptyRolling(), { mic: track(8, []), system: null }, tools)
    expect(rollingResult(state, tail, options)).toEqual({ seconds: 8, segments: [], clusters: [] })
  })
})

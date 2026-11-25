import { describe, expect, it } from 'vitest'
import { rms, VoiceDetector, type SpeechClassifier } from './vad'

const FRAME = 512

function frameOf(voiced: boolean): Float32Array {
  const frame = new Float32Array(FRAME)
  if (voiced) for (let i = 0; i < FRAME; i++) frame[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / 16000)
  return frame
}

const fakeSilero = (): SpeechClassifier => ({ isSpeech: (frame) => rms(frame) > 0.01 })

type Event = { kind: 'start'; frames: number; onset: number } | { kind: 'frame'; voiced: boolean } | { kind: 'end' }

function listen(classifier: SpeechClassifier | null): { detector: VoiceDetector; events: Event[] } {
  const events: Event[] = []
  const detector = new VoiceDetector(
    {
      onStart: (frames, onset) => events.push({ kind: 'start', frames: frames.length, onset }),
      onFrame: (_frame, voiced) => events.push({ kind: 'frame', voiced }),
      onEnd: () => events.push({ kind: 'end' })
    },
    classifier
  )
  return { detector, events }
}

describe.each([
  ['Silero', fakeSilero],
  ['energy fallback', () => null]
])('VoiceDetector (%s)', (_name, classifier) => {
  it('reports the onset with the pre-roll and which later frames were voiced', () => {
    const { detector, events } = listen(classifier())
    for (let i = 0; i < 20; i++) detector.push(frameOf(false))
    expect(detector.preRolled()).toBe(10 * FRAME)
    for (let i = 0; i < 10; i++) detector.push(frameOf(true))
    for (let i = 0; i < 50; i++) detector.push(frameOf(false))

    const [start, ...rest] = events
    expect(start).toEqual({ kind: 'start', frames: 10, onset: 3 * FRAME })
    const frames = rest.filter((event) => event.kind === 'frame')
    // Seven more voiced frames, then the end pause (1.2 s, 38 frames) heard as silence.
    expect(frames.filter((event) => event.voiced)).toHaveLength(7)
    expect(frames.filter((event) => !event.voiced)).toHaveLength(38)
    expect(rest.at(-1)).toEqual({ kind: 'end' })
    expect(rest.filter((event) => event.kind === 'end')).toHaveLength(1)
  })

  it('empties the pre-roll when speech starts and at flush', () => {
    const { detector } = listen(classifier())
    for (let i = 0; i < 5; i++) detector.push(frameOf(false))
    for (let i = 0; i < 3; i++) detector.push(frameOf(true))
    expect(detector.preRolled()).toBe(0)
    for (let i = 0; i < 50; i++) detector.push(frameOf(false))
    expect(detector.preRolled()).toBeGreaterThan(0)
    detector.flush()
    expect(detector.preRolled()).toBe(0)
  })
})

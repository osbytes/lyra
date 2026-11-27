import { describe, expect, it } from 'vitest'
import { SELF_MIC_SHARE } from './thresholds'
import { SPEAKER_EMBEDDING } from './speakerModel'
import {
  couldBeOnePerson,
  differentVoices,
  movedLines,
  ownedVoiceprints,
  pickSelfSpeaker,
  pinnedSpeakers,
  withLiveVoiceprints
} from './speakerRules'

describe('pickSelfSpeaker', () => {
  it('prefers the mic-side speaker who talked most over the first one heard', () => {
    const picked = pickSelfSpeaker(
      [
        { speaker: 0, seconds: 4, micShare: 0.9 },
        { speaker: 1, seconds: 60, micShare: 0.1 },
        { speaker: 2, seconds: 30, micShare: 0.8 }
      ],
      SELF_MIC_SHARE
    )
    expect(picked).toBe(2)
  })

  it('breaks a tie by order of appearance, and finds nobody off the mic', () => {
    const tie = [
      { speaker: 3, seconds: 10, micShare: 0.9 },
      { speaker: 1, seconds: 10, micShare: 0.9 }
    ]
    expect(pickSelfSpeaker(tie, SELF_MIC_SHARE)).toBe(3)
    expect(pickSelfSpeaker([{ speaker: 0, seconds: 10, micShare: 0.2 }], SELF_MIC_SHARE)).toBeNull()
  })
})

describe('couldBeOnePerson', () => {
  const mic = (start: number, end: number) => ({ start, end, micShare: 0.9 })
  const remote = (start: number, end: number) => ({ start, end, micShare: 0.1 })

  it('allows two halves of one voice that take turns on one side', () => {
    expect(couldBeOnePerson([mic(0, 5), mic(10, 15)], [mic(5, 10)], true)).toBe(true)
  })

  it('blocks speakers on opposite sides of a call', () => {
    expect(couldBeOnePerson([mic(0, 5)], [remote(6, 10)], true)).toBe(false)
    // Without a system track there are no sides.
    expect(couldBeOnePerson([mic(0, 5)], [remote(6, 10)], false)).toBe(true)
  })

  it('blocks speakers who talk over each other at length', () => {
    expect(couldBeOnePerson([mic(0, 10)], [mic(5, 12)], true)).toBe(false)
    expect(couldBeOnePerson([mic(0, 10)], [mic(9.5, 12)], true)).toBe(true)
  })
})

describe('ownedVoiceprints', () => {
  const print = [0.1, 0.2]

  it('takes a voiceprint only from a pass whose lines the speaker still owns', () => {
    const passes = [
      { segments: [{ id: 'pass-2-s0', cluster: 'c0' }], clusters: [{ id: 'c0', embedding: [1, 0], model: 'm' }] },
      // An older pass's c1 was someone else: the id was handed out again since.
      { segments: [{ id: 'pass-1-s0', cluster: 'c1' }], clusters: [{ id: 'c1', embedding: print }] }
    ]
    const transcript = [
      { id: 'pass-2-s0', rawId: 'pass-2-s0', cluster: 'c0' },
      { id: 'live-mic-1', rawId: null, cluster: 'c1' }
    ]
    const found = ownedVoiceprints(passes, transcript)
    expect(found.get('c0')).toEqual({ vector: [1, 0], model: 'm' })
    expect(found.has('c1')).toBe(false)
  })

  it('skips a speaker whose lines were all moved away, and guesses the model of an old pass', () => {
    const segments = [
      { id: 's0', cluster: 'c0' },
      { id: 's1', cluster: 'c1' }
    ]
    const passes = [{ segments, clusters: [{ id: 'c0', embedding: print }, { id: 'c1', embedding: print }] }]
    const transcript = [
      { id: 's0', rawId: null, cluster: 'c0' },
      { id: 's1', rawId: null, cluster: 'c0' }
    ]
    const found = ownedVoiceprints(passes, transcript)
    expect(found.get('c0')?.model).toBe('unknown')
    expect(found.has('c1')).toBe(false)
    const current = Array.from({ length: SPEAKER_EMBEDDING.dims }, () => 1)
    const modern = ownedVoiceprints([{ segments, clusters: [{ id: 'c0', embedding: current }] }], transcript)
    expect(modern.get('c0')?.model).toBe(SPEAKER_EMBEDDING.model)
  })
})

describe('movedLines and pinnedSpeakers', () => {
  it('finds lines the user moved and pins the words inside them', () => {
    const transcript = [
      { id: 'pass-1-s0', rawId: 'pass-1-s0', cluster: 'c0', start: 0, end: 4 },
      { id: 'pass-1-s1', rawId: 'pass-1-s1', cluster: 'c2', start: 4, end: 8 },
      { id: 'live-mic-9', rawId: null, cluster: 'c1', start: 8, end: 9 }
    ]
    const passes = new Map([
      ['pass-1-s0', 'c0'],
      ['pass-1-s1', 'c1']
    ])
    const moved = movedLines(transcript, passes)
    expect(moved.map((line) => line.id)).toEqual(['pass-1-s1'])
    const words = [
      { start: 1, end: 2 },
      { start: 5, end: 6 },
      { start: 8.2, end: 8.6 }
    ]
    expect(pinnedSpeakers(words, moved)).toEqual([null, 'c2', null])
  })
})

describe('movedLines over a live pass', () => {
  it('leaves a live line where the live pass recorded no speaker for it', () => {
    // The live pass keeps each chunk under the id its line got, with no speaker; the line shows
    // the track's speaker. That isn't the user moving it.
    const transcript = [
      { id: 'live-mic-0', rawId: null, cluster: 'c0', start: 0, end: 4 },
      { id: 'live-system-5000', rawId: null, cluster: 'c1', start: 5, end: 7 },
      { id: 'pass-1-s2', rawId: 'pass-1-s2', cluster: 'c0', start: 8, end: 9 }
    ]
    const passes = new Map<string, string | null>([
      ['live-mic-0', null],
      ['live-system-5000', null],
      ['pass-1-s2', 'c1']
    ])
    const moved = movedLines(transcript, passes)
    expect(moved.map((line) => line.id)).toEqual(['pass-1-s2'])
    expect(pinnedSpeakers([{ start: 1, end: 2 }, { start: 5, end: 6 }, { start: 8.2, end: 8.6 }], moved)).toEqual([
      null,
      null,
      'c0'
    ])
  })
})

describe('movedLines with the user mark', () => {
  it('pins a live line the user assigned, which has no pass to compare with', () => {
    const transcript = [
      { id: 'live-mic-0', rawId: null, cluster: 'c3', start: 0, end: 4, userCluster: true },
      { id: 'live-mic-5', rawId: null, cluster: 'c0', start: 5, end: 7, userCluster: false },
      // A marked line with no speaker has nothing to pin.
      { id: 'live-mic-8', rawId: null, cluster: null, start: 8, end: 9, userCluster: true }
    ]
    const moved = movedLines(transcript, new Map())
    expect(moved.map((line) => line.id)).toEqual(['live-mic-0'])
    expect(pinnedSpeakers([{ start: 1, end: 2 }, { start: 5, end: 6 }], moved)).toEqual(['c3', null])
  })

  it('pins a marked line even where diarization agreed with the user', () => {
    const transcript = [{ id: 'pass-1-s0', rawId: 'pass-1-s0', cluster: 'c1', start: 0, end: 4, userCluster: true }]
    expect(movedLines(transcript, new Map([['pass-1-s0', 'c1']]))).toHaveLength(1)
  })
})

describe('differentVoices', () => {
  it('tells two voices apart by the angle between their voiceprints', () => {
    // cosine([1, 0], [0.6, 0.8]) = 0.6; cosine([1, 0], [0.28, 0.96]) = 0.28
    expect(differentVoices([1, 0], [0.6, 0.8], 0.35)).toBe(false)
    expect(differentVoices([1, 0], [0.28, 0.96], 0.35)).toBe(true)
    expect(differentVoices([1, 0], [0, 1], 0.35)).toBe(true)
  })

  it('rules nothing out without two comparable voiceprints', () => {
    expect(differentVoices([], [0, 1], 0.35)).toBe(false)
    expect(differentVoices([1, 0], [], 0.35)).toBe(false)
    expect(differentVoices([1, 0], [0, 1, 0], 0.35)).toBe(false)
  })
})

describe('withLiveVoiceprints', () => {
  const print = (x: number): { vector: number[]; model: string } => ({ vector: [x, 1], model: 'm' })

  it('gives a speaker named while recording the voiceprint the live round heard', () => {
    // No pass yet: live lines have no raw id, so only the round can vouch for the voice.
    const transcript = [{ cluster: 's1', userCluster: false }]
    const found = withLiveVoiceprints(new Map(), new Map([['s1', print(1)]]), transcript)
    expect(found.get('s1')).toEqual(print(1))
  })

  it('outranks an older pass for the same speaker', () => {
    const transcript = [{ cluster: 's1', userCluster: false }]
    const found = withLiveVoiceprints(new Map([['s1', print(0)]]), new Map([['s1', print(2)]]), transcript)
    expect(found.get('s1')).toEqual(print(2))
  })

  it("doesn't vouch for a speaker who only holds lines the user moved, or none", () => {
    const transcript = [{ cluster: 's1', userCluster: true }, { cluster: null }]
    const live = new Map([
      ['s1', print(1)],
      ['s2', print(2)]
    ])
    expect(withLiveVoiceprints(new Map([['s0', print(0)]]), live, transcript)).toEqual(new Map([['s0', print(0)]]))
  })
})

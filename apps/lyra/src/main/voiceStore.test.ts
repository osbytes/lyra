import { describe, expect, it } from 'vitest'
import { SPEAKER_EMBEDDING } from './meeting/speakerModel'
import {
  addSampleTo,
  parseVoices,
  personScore,
  serializeVoices,
  type SampleSource,
  type StoredPerson,
  type VoiceSample
} from './voiceStore'

const MODEL = SPEAKER_EMBEDDING.model
const DIMS = SPEAKER_EMBEDDING.dims

const vector = (seed: number, dims: number = DIMS): number[] =>
  Array.from({ length: dims }, (_, i) => Math.sin(seed * 7 + i))

const sample = (source: SampleSource, sessionId: string | null, seed = 1): VoiceSample => ({
  vector: vector(seed),
  model: MODEL,
  dims: DIMS,
  source,
  sessionId,
  createdAt: '2026-01-01T00:00:00.000Z'
})

const person = (samples: VoiceSample[]): StoredPerson => ({
  id: 'p1',
  name: 'Ada',
  self: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  samples
})

describe('parseVoices', () => {
  it('upgrades a version 1 file: first sample enrolled, the rest automatic', () => {
    const legacy = [
      { id: 'p1', name: 'Ada', self: true, createdAt: 'x', samples: 3, embeddings: [vector(1), vector(2), vector(3, 256)] }
    ]
    const state = parseVoices(legacy)
    expect(state?.unreadable).toEqual([])
    const samples = state?.people[0]?.samples ?? []
    expect(samples.map((entry) => entry.source)).toEqual(['enrolled', 'auto', 'auto'])
    // A sample of another length came from the earlier model and can't be compared.
    expect(samples.map((entry) => entry.model)).toEqual([MODEL, MODEL, 'unknown'])
    expect(samples.every((entry) => entry.sessionId === null)).toBe(true)
  })

  it('keeps entries it cannot read, verbatim, through a save', () => {
    const future = { id: 'p2', name: 'Bob', voice: { kind: 'v9' } }
    const state = parseVoices({ version: 2, people: [{ ...person([sample('enrolled', null)]), extra: 1 }, future] })
    expect(state?.people).toHaveLength(1)
    expect(state?.unreadable).toEqual([future])
    const saved: unknown = JSON.parse(serializeVoices(state ?? { people: [], unreadable: [] }))
    expect(saved).toMatchObject({ version: 2, people: [{ id: 'p1', extra: 1 }, future] })
  })

  it('returns null for a file that is not a voices file', () => {
    expect(parseVoices(null)).toBeNull()
    expect(parseVoices({ hello: 'world' })).toBeNull()
  })

  it('does not accept a sample with a non-finite value', () => {
    const broken = { ...person([]), samples: [{ ...sample('auto', null), vector: [1, null, 2] }] }
    expect(parseVoices({ version: 2, people: [broken] })?.unreadable).toHaveLength(1)
  })
})

describe('addSampleTo', () => {
  it('replaces the automatic sample of the same session instead of adding another', () => {
    let current = person([sample('enrolled', null)])
    current = addSampleTo(current, sample('auto', 's1', 2))
    current = addSampleTo(current, sample('auto', 's1', 3))
    expect(current.samples.map((entry) => [entry.source, entry.sessionId])).toEqual([
      ['enrolled', null],
      ['auto', 's1']
    ])
    expect(current.samples[1]?.vector).toEqual(vector(3))
  })

  it('learns nothing automatically from a session the user already taught', () => {
    const current = person([sample('enrolled', null), sample('user', 's1')])
    expect(addSampleTo(current, sample('auto', 's1'))).toBe(current)
  })

  it('evicts the oldest automatic sample first and never the enrolled one', () => {
    let current = person([sample('enrolled', null, 0), sample('user', 'u', 1)])
    for (let i = 0; i < 5; i++) current = addSampleTo(current, sample('auto', `s${String(i)}`, i + 2), 4)
    expect(current.samples.map((entry) => entry.sessionId)).toEqual([null, 'u', 's3', 's4'])
  })

  it('drops a new automatic sample when only pinned samples are left to evict', () => {
    const full = person([sample('enrolled', null), sample('user', 'a'), sample('user', 'b')])
    expect(addSampleTo(full, sample('auto', 'c'), 3)).toBe(full)
  })

  it('lets a user sample push out older user samples before the enrolled one', () => {
    const full = person([sample('enrolled', null), sample('user', 'a'), sample('user', 'b')])
    const next = addSampleTo(full, sample('user', 'c'), 3)
    expect(next.samples.map((entry) => entry.sessionId)).toEqual([null, 'b', 'c'])
  })
})

describe('personScore', () => {
  const context = { model: MODEL, dims: DIMS, sessionId: 's1' }

  it('ignores samples from the session being labeled', () => {
    const own = person([sample('auto', 's1', 5)])
    expect(personScore(own, vector(5), context)).toBeNull()
    const both = person([sample('auto', 's1', 5), sample('enrolled', null, 9)])
    expect(personScore(both, vector(5), context)).toBeLessThan(0.99)
  })

  it('ignores samples from another model or size', () => {
    const other = person([{ ...sample('enrolled', null, 5), model: 'unknown' }])
    expect(personScore(other, vector(5), context)).toBeNull()
    const short = person([{ ...sample('enrolled', null), vector: vector(5, 3), dims: 3 }])
    expect(personScore(short, vector(5), context)).toBeNull()
  })

  it('scores a matching sample', () => {
    expect(personScore(person([sample('enrolled', null, 5)]), vector(5), context)).toBeCloseTo(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { SpeakerEntry } from '../../../shared/sessionDoc'
import type { Person } from '../../../shared/types'
import { defaultHighlight, speakerOptions, type SpeakerOption } from './speakerOptions'

const person = (id: string, name: string): Person => ({ id, name, self: false, createdAt: '', samples: 1 })
const speaker = (id: string, name: string, personId: string | null = null): SpeakerEntry => ({
  id,
  name,
  personId,
  confirmed: false,
  confidence: null,
  matches: []
})

const label = (option: SpeakerOption): string =>
  option.kind === 'person'
    ? `${option.group}:${option.person.name}`
    : option.kind === 'speaker'
      ? `here:${option.speaker.name}`
      : option.kind === 'new'
        ? `new:${option.name}`
        : 'keep'

const people = [person('p-dillon', 'dillon'), person('p-angel', 'angel'), person('p-eric', 'eric')]
const unknown = {
  ...speaker('s5', 'Speaker 1'),
  // 0.7 is a possible match (LOW_CONFIDENCE 0.6); 0.3 is unlikely.
  matches: [
    { personId: 'p-angel', score: 0.7 },
    { personId: 'p-dillon', score: 0.3 }
  ]
}
const speakers = [speaker('s1', 'eric', 'p-eric'), speaker('s2', 'sid'), unknown]

describe('speakerOptions', () => {
  it('suggests only voices that could be this speaker, then who is here, then everyone saved', () => {
    const options = speakerOptions({ query: '', speaker: unknown, speakers, people })
    expect(options.map(label)).toEqual(['match:angel', 'here:eric', 'here:sid', 'saved:dillon', 'keep'])
  })

  it('filters every group by what was typed and offers a new person when nobody fits', () => {
    expect(speakerOptions({ query: 'si', speaker: unknown, speakers, people }).map(label)).toEqual([
      'here:sid',
      'new:si',
      'keep'
    ])
    // A name already in the session isn't offered again as someone new.
    expect(speakerOptions({ query: 'Sid', speaker: unknown, speakers, people }).map(label)).toEqual(['here:sid', 'keep'])
  })
})

describe('defaultHighlight', () => {
  it('picks a likely voice, else nothing, before anything is typed', () => {
    expect(defaultHighlight(speakerOptions({ query: '', speaker: unknown, speakers, people }), '')).toBe(0)
    const noMatch = { ...unknown, matches: [{ personId: 'p-dillon', score: 0.3 }] }
    expect(defaultHighlight(speakerOptions({ query: '', speaker: noMatch, speakers, people }), '')).toBe(-1)
  })

  it('picks the exact name typed, else the first that fits', () => {
    const exact = speakerOptions({ query: 'eric', speaker: unknown, speakers, people })
    expect(defaultHighlight(exact, 'eric')).toBe(0)
    const typed = speakerOptions({ query: 'Lily', speaker: unknown, speakers, people })
    expect(typed.map(label)[defaultHighlight(typed, 'Lily')]).toBe('new:Lily')
  })
})

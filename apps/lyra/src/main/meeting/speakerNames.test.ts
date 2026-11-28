import { describe, expect, it } from 'vitest'
import { emptyDoc, upsertSpeaker, type SessionDoc } from '../../shared/sessionDoc'
import { introduceSpeakers, namesFrom, personNamed, sameName, speakerTranscript } from './speakerNames'

function session(lines: [string | null, string][]): SessionDoc {
  const doc = emptyDoc({ title: 't', notes: '' })
  doc.transcript = lines.map(([cluster, text], index) => ({
    id: `l${String(index)}`,
    rawId: null,
    start: index,
    end: index + 1,
    cluster,
    userCluster: false,
    text,
    original: text,
    edits: [],
    edited: false,
    confidence: null
  }))
  return doc
}

describe('speakerTranscript', () => {
  it('labels unnamed voices in order heard, hiding weak guesses, and keeps settled names', () => {
    const doc = session([
      ['c1', 'Morning.'],
      ['c0', 'Hi all.'],
      [null, 'Hello?'],
      ['c2', '  '],
      ['c1', 'Maya, go ahead.']
    ])
    upsertSpeaker(doc, 'c0', { name: 'Dana', confirmed: true })
    upsertSpeaker(doc, 'c1', { name: 'Sam', personId: 'p2', confidence: 0.6 })
    upsertSpeaker(doc, 'c2', { name: 'Speaker 2' })
    const view = speakerTranscript(doc)
    expect(view?.text).toBe(
      '[1] Speaker A: Morning.\n[2] Dana: Hi all.\n[3] Unknown speaker: Hello?\n[4] Speaker A: Maya, go ahead.'
    )
    // c2 said nothing, so it isn't offered.
    expect([...(view?.labels ?? [])]).toEqual([['Speaker A', 'c1']])
    expect(view?.lines).toEqual(['l0', 'l1', 'l2', 'l4'])
  })

  it('has nothing to ask when every speaker is settled', () => {
    const doc = session([['c0', 'Hi.']])
    upsertSpeaker(doc, 'c0', { name: 'Sam', personId: 'p2', confidence: 0.9 })
    expect(speakerTranscript(doc)).toBeNull()
  })
})

describe('namesFrom', () => {
  const view = {
    text: '',
    labels: new Map([
      ['Speaker A', 'c1'],
      ['Speaker B', 'c2'],
      ['Speaker C', 'c3']
    ]),
    lines: ['l0', 'l1', 'l2'],
    texts: ['Hi, I’m Maya. Dana, Priya and Sam are here too.', 'Thanks, Sam! 42 slides…', 'Maya Chen, by the way. Priya?']
  }
  const answer = (...speakers: [string, string, number][]) => ({
    speakers: speakers.map(([label, name, line]) => ({ label, name, line }))
  })

  it('maps labels and line numbers back to ids, keeping the fullest name', () => {
    const found = namesFrom(answer(['Speaker A', 'Maya', 1], ['Speaker A', 'Maya  Chen', 3]), view)
    expect([...found]).toEqual([['c1', { name: 'Maya Chen', lineId: 'l2' }]])
  })

  it('drops labels it was not given, lines that do not exist, and things that are not names', () => {
    const found = namesFrom(
      answer(
        ['Dana', 'Dana', 1],
        ['Speaker A', 'Maya', 9],
        ['Speaker A', 'Maya', 1.5],
        ['Speaker B', '42', 2],
        ['Speaker C', '', 0],
        ['Speaker C', 'x'.repeat(61), 1]
      ),
      view
    )
    expect(found.size).toBe(0)
  })

  it('drops a name the line it cites doesn’t say (one the model made up)', () => {
    expect(namesFrom(answer(['Speaker B', 'Jordan', 2]), view).size).toBe(0)
    expect([...namesFrom(answer(['Speaker B', 'Sam', 2]), view)]).toEqual([['c2', { name: 'Sam', lineId: 'l1' }]])
  })

  it('drops a speaker named two ways, and a name given to two speakers', () => {
    const found = namesFrom(
      answer(['Speaker A', 'Maya', 1], ['Speaker A', 'Sam', 2], ['Speaker B', 'Priya', 1], ['Speaker C', 'priya', 3]),
      view
    )
    expect(found.size).toBe(0)
  })
})

describe('sameName and personNamed', () => {
  const people = [
    { id: 'p1', name: 'Maya Chen' },
    { id: 'p2', name: 'Sam' },
    { id: 'p3', name: 'Sam Ortiz' }
  ]
  it('treats a first name and a full name as one, without case or accents', () => {
    expect(sameName('Maya', 'maya chen')).toBe(true)
    expect(sameName('Zoe', 'Zoë')).toBe(true)
    expect(sameName('Sam', 'Samantha')).toBe(false)
  })
  it('takes the same name, else the only person it can be short for', () => {
    expect(personNamed(people, 'maya')?.id).toBe('p1')
    expect(personNamed(people, 'Sam')?.id).toBe('p2')
    expect(personNamed([{ id: 'a', name: 'Sam Lee' }, { id: 'b', name: 'Sam Ortiz' }], 'Sam')).toBeNull()
  })
})

describe('introduceSpeakers', () => {
  const found = (id: string, name: string, lineId = 'l0') => new Map([[id, { name, lineId }]])

  it('names a new person as said, a likely guess with nothing saved, and renumbers the rest', () => {
    const doc = session([
      ['c0', "I'm Priya."],
      ['c1', 'Hi.']
    ])
    upsertSpeaker(doc, 'c0', { name: 'Speaker 1' })
    upsertSpeaker(doc, 'c1', { name: 'Speaker 2' })
    expect(introduceSpeakers(doc, found('c0', 'Priya'), [])).toBe(1)
    expect(doc.speakers[0]).toMatchObject({
      name: 'Priya',
      personId: null,
      confirmed: false,
      introduced: { name: 'Priya', lineId: 'l0' }
    })
    expect(doc.speakers[1]?.name).toBe('Speaker 1')
  })

  it('links a saved person, dropping a weak match for someone else', () => {
    const doc = session([['c0', 'Hey.']])
    upsertSpeaker(doc, 'c0', { name: 'Sam', personId: 'p2', confidence: 0.6 })
    introduceSpeakers(doc, found('c0', 'Maya'), [
      { id: 'p1', name: 'Maya Chen' },
      { id: 'p2', name: 'Sam' }
    ])
    expect(doc.speakers[0]).toMatchObject({ name: 'Maya Chen', personId: 'p1', confidence: null })
  })

  it('leaves a speaker the user named meanwhile, or a sure voice, alone', () => {
    const doc = session([
      ['c0', 'a'],
      ['c1', 'b']
    ])
    upsertSpeaker(doc, 'c0', { name: 'Dana', confirmed: true })
    upsertSpeaker(doc, 'c1', { name: 'Sam', personId: 'p2', confidence: 0.9 })
    const both = new Map([
      ['c0', { name: 'Maya', lineId: 'l0' }],
      ['c1', { name: 'Priya', lineId: 'l1' }]
    ])
    expect(introduceSpeakers(doc, both, [])).toBe(0)
  })

  it('skips a finding whose line is gone', () => {
    const doc = session([['c0', 'Hi.']])
    upsertSpeaker(doc, 'c0', { name: 'Speaker 1' })
    expect(introduceSpeakers(doc, found('c0', 'Maya', 'gone'), [])).toBe(0)
  })

  it('won’t give a name or a saved person someone else here already has', () => {
    const doc = session([
      ['c0', 'a'],
      ['c1', 'b'],
      ['c2', 'c']
    ])
    upsertSpeaker(doc, 'c0', { name: 'Maya', confirmed: true })
    upsertSpeaker(doc, 'c1', { name: 'Sam Ortiz', personId: 'p3', confidence: 0.7 })
    upsertSpeaker(doc, 'c2', { name: 'Speaker 1' })
    expect(introduceSpeakers(doc, found('c2', 'Maya'), [])).toBe(0)
    expect(introduceSpeakers(doc, found('c2', 'Sam Ortiz'), [{ id: 'p3', name: 'Sam Ortiz' }])).toBe(0)
  })
})

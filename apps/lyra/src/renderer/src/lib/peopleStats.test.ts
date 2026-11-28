import { describe, expect, it } from 'vitest'
import type { PeopleActivity } from '../../../shared/peopleActivity'
import { personDetail, personTotals, rosterOf, sortPeople, totalsOf, weekStart } from './peopleStats'

const ana = { id: 'a', name: 'Ana' }
const ben = { id: 'b', name: 'Ben' }
const cy = { id: 'c', name: 'Cy' }
const people = [cy, ben, ana]

// Local times (no Z), so the week buckets don't depend on the machine's time zone.
const activity: PeopleActivity = {
  sessions: [
    { id: 's1', title: 'Sync', startedAt: '2026-11-24T10:00:00', seconds: 900, talkSeconds: 600, tags: ['sync'] },
    { id: 's2', title: 'Plan', startedAt: '2026-11-10T10:00:00', seconds: 200, talkSeconds: 120, tags: ['sync', 'plan'] }
  ],
  appearances: [
    { sessionId: 's1', personId: 'a', name: 'Ana', talkSeconds: 300, lines: 10, words: 600 },
    { sessionId: 's1', personId: 'b', name: 'Ben', talkSeconds: 200, lines: 5, words: 300 },
    { sessionId: 's2', personId: 'a', name: 'Ana', talkSeconds: 30, lines: 2, words: 50 }
  ],
  actionItems: [
    { sessionId: 's1', owner: 'ana ', task: 'Send the deck', done: false },
    { sessionId: 's1', owner: 'Ben', task: 'Book a room', done: true },
    // Cy didn't speak in s1, so an item with their name there isn't theirs.
    { sessionId: 's1', owner: 'Cy', task: 'Not theirs', done: false },
    { sessionId: 's2', owner: 'Ana', task: 'Draft the plan', done: true }
  ]
}

describe('personTotals', () => {
  const totals = personTotals(people, activity)

  it('adds up talk, lines and words across sessions', () => {
    const t = totalsOf(totals, 'a')
    expect(t.sessions).toBe(2)
    expect(t.talkSeconds).toBe(330)
    expect(t.lines).toBe(12)
    expect(t.words).toBe(650)
    // 330 of the 600 + 120 seconds spoken in their sessions.
    expect(t.share).toBeCloseTo(330 / 720)
    // 650 words in 5.5 minutes.
    expect(t.pace).toBe(118)
    expect(t.firstSeen).toBe('2026-11-10T10:00:00')
    expect(t.lastSeen).toBe('2026-11-24T10:00:00')
    expect(t.openActions).toBe(1)
  })

  it('works out share and pace per person', () => {
    const t = totalsOf(totals, 'b')
    expect(t.share).toBeCloseTo(1 / 3)
    expect(t.pace).toBe(90)
    expect(t.openActions).toBe(0)
  })

  it('gives someone never heard zeros and no share', () => {
    expect(totalsOf(totals, 'c')).toEqual({
      sessions: 0,
      talkSeconds: 0,
      lines: 0,
      words: 0,
      share: null,
      pace: null,
      firstSeen: null,
      lastSeen: null,
      openActions: 0
    })
  })

  it('leaves pace out under a minute of talk', () => {
    const short = personTotals([ana], { ...activity, appearances: activity.appearances.slice(2) })
    expect(totalsOf(short, 'a').pace).toBeNull()
  })
})

describe('personDetail', () => {
  const detail = personDetail(ana, activity, 4, new Date(2026, 10, 27, 15))

  it('lists their sessions newest first with their part', () => {
    expect(detail.sessions.map((session) => [session.id, session.theirSeconds, session.share, session.with])).toEqual([
      ['s1', 300, 0.5, ['b']],
      ['s2', 30, 0.25, []]
    ])
  })

  it('buckets talk time by week, Monday first', () => {
    expect(detail.weeks.map((week) => [week.start.getDate(), week.seconds, week.sessions])).toEqual([
      [2, 0, 0],
      [9, 30, 1],
      [16, 0, 0],
      [23, 300, 1]
    ])
  })

  it('counts who they were with, their tags and their action items', () => {
    expect(detail.together).toEqual([{ personId: 'b', sessions: 1 }])
    expect(detail.tags).toEqual([
      ['sync', 2],
      ['plan', 1]
    ])
    expect(detail.actions.map((item) => [item.task, item.title])).toEqual([
      ['Send the deck', 'Sync'],
      ['Draft the plan', 'Plan']
    ])
  })
})

describe('weekStart', () => {
  it('goes back to Monday, and keeps a Monday', () => {
    expect(weekStart(new Date(2026, 10, 29)).getDate()).toBe(23)
    expect(weekStart(new Date(2026, 10, 23, 9)).getDate()).toBe(23)
  })
})

describe('sortPeople', () => {
  const totals = personTotals(people, activity)
  const names = (by: Parameters<typeof sortPeople>[2]): string[] =>
    sortPeople(people, totals, by).map((person) => person.name)

  it('orders by talk, sessions, recency or name', () => {
    expect(names('talk')).toEqual(['Ana', 'Ben', 'Cy'])
    expect(names('sessions')).toEqual(['Ana', 'Ben', 'Cy'])
    // Ana and Ben were both last heard in s1: the name breaks the tie; never heard goes last.
    expect(names('recent')).toEqual(['Ana', 'Ben', 'Cy'])
    expect(names('name')).toEqual(['Ana', 'Ben', 'Cy'])
  })
})

describe('rosterOf', () => {
  const anaVoice = { id: 'a', name: 'Ana', self: false, createdAt: '2026-11-01T00:00:00', samples: 2 }
  const saved = [anaVoice]
  const named: PeopleActivity = {
    sessions: activity.sessions,
    appearances: [
      // Linked to Ana's voice, and heard again as a second speaker only named "ana".
      { sessionId: 's1', personId: 'a', name: 'Ana', talkSeconds: 300, lines: 10, words: 600 },
      { sessionId: 's1', personId: null, name: 'ana', talkSeconds: 20, lines: 1, words: 40 },
      { sessionId: 's1', personId: null, name: 'Dillon', talkSeconds: 200, lines: 5, words: 300 },
      { sessionId: 's1', personId: null, name: 'Speaker 3', talkSeconds: 50, lines: 2, words: 90 },
      // A deleted voice falls back to the name.
      { sessionId: 's2', personId: 'gone', name: 'Dillon', talkSeconds: 30, lines: 2, words: 50 },
      { sessionId: 's2', personId: null, name: 'Me', talkSeconds: 60, lines: 3, words: 100 }
    ],
    actionItems: []
  }
  const roster = rosterOf(saved, named)

  it('lists saved voices first, then each name, and leaves "Speaker N" out', () => {
    expect(roster.people.map((person) => [person.id, person.name, person.self, person.voice?.samples ?? null])).toEqual([
      ['a', 'Ana', false, 2],
      ['name:dillon', 'Dillon', false, null],
      ['name:me', 'Me', true, null]
    ])
  })

  it('points every speaker at who they are, adding up a person heard twice in one session', () => {
    const totals = personTotals(roster.people, roster.activity)
    expect(totalsOf(totals, 'a').talkSeconds).toBe(320)
    expect(totalsOf(totals, 'a').sessions).toBe(1)
    expect(totalsOf(totals, 'name:dillon').talkSeconds).toBe(230)
    expect(totalsOf(totals, 'name:dillon').sessions).toBe(2)
  })

  it('keeps "Me" as someone else when a saved voice is you', () => {
    const mine = rosterOf([{ ...anaVoice, self: true }], named)
    expect(mine.people.find((person) => person.id === 'name:me')?.self).toBe(false)
  })
})

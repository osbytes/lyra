import type { PeopleActivity } from '../../../shared/peopleActivity'

/** The numbers the People pages show, worked out from who spoke where (shared/peopleActivity). */

type PersonRef = { id: string; name: string }
type Session = PeopleActivity['sessions'][number]

/** Someone on the People pages: a saved voice, or a name given to speakers in sessions. */
export type RosterPerson = {
  /** The saved person's id, or `name:` and the lower-cased name for someone only named. */
  id: string
  name: string
  self: boolean
  /** Their saved voice; null when they've only been named. */
  voice: { createdAt: string; samples: number } | null
}

type SavedPerson = { id: string; name: string; self: boolean; createdAt: string; samples: number }

const nameKey = (name: string): string => name.trim().toLowerCase()
/** "Speaker 2" (or a blank name) is a speaker nobody has named yet. */
const unnamed = (name: string): boolean => !name.trim() || /^speaker\s+\d+$/i.test(name.trim())

/**
 * Everyone to list: each saved voice, then each name given to speakers that isn't one, and the
 * activity with every speaker pointed at who they are. A speaker linked to a saved voice is that
 * person; one only named joins the saved person of the same name, or their name's own entry. A
 * person heard as two speakers in one session counts once, their talk added up. "Me" with no
 * saved voice marked as you is you: the mic track is labeled "Me" until one is.
 */
export function rosterOf(
  saved: readonly SavedPerson[],
  activity: PeopleActivity
): { people: RosterPerson[]; activity: PeopleActivity } {
  const byId = new Map(saved.map((person) => [person.id, person]))
  const byName = new Map(saved.map((person) => [nameKey(person.name), person]))
  const hasSelf = saved.some((person) => person.self)
  const named = new Map<string, RosterPerson>()
  const merged = new Map<string, PeopleActivity['appearances'][number]>()
  for (const entry of activity.appearances) {
    let id = entry.personId !== null && byId.has(entry.personId) ? entry.personId : null
    if (id === null) {
      if (unnamed(entry.name)) continue
      const key = nameKey(entry.name)
      const person = byName.get(key)
      id = person ? person.id : `name:${key}`
      if (!person && !named.has(id)) {
        named.set(id, { id, name: entry.name.trim(), self: !hasSelf && key === 'me', voice: null })
      }
    }
    const at = `${entry.sessionId}\u0000${id}`
    const before = merged.get(at)
    merged.set(
      at,
      before
        ? {
            ...before,
            talkSeconds: before.talkSeconds + entry.talkSeconds,
            lines: before.lines + entry.lines,
            words: before.words + entry.words
          }
        : { ...entry, personId: id }
    )
  }
  return {
    people: [
      ...saved.map((person) => ({
        id: person.id,
        name: person.name,
        self: person.self,
        voice: { createdAt: person.createdAt, samples: person.samples }
      })),
      ...named.values()
    ],
    activity: { ...activity, appearances: [...merged.values()] }
  }
}

export type PersonTotals = {
  sessions: number
  talkSeconds: number
  lines: number
  words: number
  /** Their part of all the talking in the sessions they were in, 0–1; null with no talk at all. */
  share: number | null
  /** Words per minute of their own talk; null under a minute, where it says little. */
  pace: number | null
  firstSeen: string | null
  lastSeen: string | null
  openActions: number
}

const EMPTY: PersonTotals = {
  sessions: 0,
  talkSeconds: 0,
  lines: 0,
  words: 0,
  share: null,
  pace: null,
  firstSeen: null,
  lastSeen: null,
  openActions: 0
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Action items whose owner is this person, from sessions they spoke in. */
function actionsOf(person: PersonRef, activity: PeopleActivity): PeopleActivity['actionItems'] {
  const theirs = new Set(
    activity.appearances.filter((entry) => entry.personId === person.id).map((entry) => entry.sessionId)
  )
  return activity.actionItems.filter((item) => theirs.has(item.sessionId) && sameName(item.owner, person.name))
}

/** Every person's totals, by id; a person never heard gets zeros. */
export function personTotals(people: readonly PersonRef[], activity: PeopleActivity): Map<string, PersonTotals> {
  const sessions = new Map(activity.sessions.map((session) => [session.id, session]))
  const out = new Map<string, PersonTotals>()
  for (const person of people) {
    let talk = 0
    let lines = 0
    let words = 0
    let roomTalk = 0
    const dates: string[] = []
    for (const entry of activity.appearances) {
      if (entry.personId !== person.id) continue
      const session = sessions.get(entry.sessionId)
      if (!session) continue
      talk += entry.talkSeconds
      lines += entry.lines
      words += entry.words
      roomTalk += session.talkSeconds
      dates.push(session.startedAt)
    }
    dates.sort()
    out.set(person.id, {
      sessions: dates.length,
      talkSeconds: talk,
      lines,
      words,
      share: roomTalk > 0 ? Math.min(1, talk / roomTalk) : null,
      pace: talk >= 60 ? Math.round(words / (talk / 60)) : null,
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      openActions: actionsOf(person, activity).filter((item) => !item.done).length
    })
  }
  return out
}

export const totalsOf = (totals: Map<string, PersonTotals>, id: string): PersonTotals => totals.get(id) ?? EMPTY

export type PersonSession = Session & {
  /** This person's talk time in it. */
  theirSeconds: number
  /** Their part of the session's talking, 0–1; null when nobody's talk was measured. */
  share: number | null
  /** The other saved people in it. */
  with: string[]
}

export type PersonDetail = {
  sessions: PersonSession[]
  /** Their talk time per week, oldest first; the last week holds `now`. */
  weeks: { start: Date; seconds: number; sessions: number }[]
  /** Saved people they were heard with, most sessions together first. */
  together: { personId: string; sessions: number }[]
  /** Tags of the sessions they spoke in, most used first. */
  tags: [string, number][]
  actions: (PeopleActivity['actionItems'][number] & { title: string })[]
}

const DAY_MS = 86_400_000

/** Monday 00:00 of the week holding `date`, local time. */
export function weekStart(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

/** One person's sessions, newest first, with the weekly chart and who they talk with. */
export function personDetail(person: PersonRef, activity: PeopleActivity, weekCount: number, now: Date): PersonDetail {
  const mine = new Map(
    activity.appearances.filter((entry) => entry.personId === person.id).map((entry) => [entry.sessionId, entry])
  )
  const sessions: PersonSession[] = []
  const together = new Map<string, number>()
  const tags = new Map<string, number>()
  for (const session of activity.sessions) {
    const entry = mine.get(session.id)
    if (!entry) continue
    // After rosterOf every speaker has an id; an unresolved one (null) is nobody to list.
    const others = activity.appearances.flatMap((other) =>
      other.sessionId === session.id && other.personId !== null && other.personId !== person.id ? [other.personId] : []
    )
    for (const id of others) together.set(id, (together.get(id) ?? 0) + 1)
    for (const tag of session.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
    sessions.push({
      ...session,
      theirSeconds: entry.talkSeconds,
      share: session.talkSeconds > 0 ? Math.min(1, entry.talkSeconds / session.talkSeconds) : null,
      with: others
    })
  }
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const last = weekStart(now)
  const weeks = Array.from({ length: weekCount }, (_, index) => {
    const start = new Date(last)
    start.setDate(start.getDate() - (weekCount - 1 - index) * 7)
    return { start, seconds: 0, sessions: 0 }
  })
  for (const session of sessions) {
    const started = weekStart(new Date(session.startedAt)).getTime()
    // Round, not floor: a daylight-saving change makes a week an hour short or long.
    const back = Math.round((last.getTime() - started) / (7 * DAY_MS))
    const week = weeks[weekCount - 1 - back]
    if (back < 0 || !week) continue
    week.seconds += session.theirSeconds
    week.sessions++
  }

  const titles = new Map(activity.sessions.map((session) => [session.id, session.title]))
  return {
    sessions,
    weeks,
    together: [...together].map(([personId, count]) => ({ personId, sessions: count })).sort((a, b) => b.sessions - a.sessions),
    tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    actions: actionsOf(person, activity).map((item) => ({ ...item, title: titles.get(item.sessionId) ?? '' }))
  }
}

export type PeopleSort = 'talk' | 'sessions' | 'recent' | 'name'

/** The list's order; ties fall back to the name, so it never shuffles. */
export function sortPeople<P extends PersonRef>(
  people: readonly P[],
  totals: Map<string, PersonTotals>,
  by: PeopleSort
): P[] {
  const key = (person: P): number | string => {
    const t = totalsOf(totals, person.id)
    switch (by) {
      case 'talk':
        return -t.talkSeconds
      case 'sessions':
        return -t.sessions
      case 'recent':
        return t.lastSeen ? -new Date(t.lastSeen).getTime() : Infinity
      case 'name':
        return 0
    }
  }
  return people.toSorted((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** What the Home dashboard counts from the library: plain numbers from each session's summary. */
type Session = { id: string; startedAt: string; seconds: number | null; speakers: number; tags: readonly string[] }

const DAY_MS = 86_400_000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export type WeekStats = {
  sessions: number
  /** Seconds recorded. */
  seconds: number
  meetings: number
  dictations: number
}

function statsOf(sessions: readonly Session[]): WeekStats {
  let seconds = 0
  let meetings = 0
  let dictations = 0
  for (const session of sessions) {
    seconds += session.seconds ?? 0
    if (session.speakers > 1) meetings++
    else if (session.seconds !== null) dictations++
  }
  return { sessions: sessions.length, seconds, meetings, dictations }
}

/** The last seven days (today included) against the seven before them. */
export function weekStats(sessions: readonly Session[], now = new Date()): { current: WeekStats; previous: WeekStats } {
  const today = startOfDay(now)
  const from = today - 6 * DAY_MS
  const before = from - 7 * DAY_MS
  const at = (session: Session): number => new Date(session.startedAt).getTime()
  return {
    current: statsOf(sessions.filter((s) => at(s) >= from)),
    previous: statsOf(sessions.filter((s) => at(s) >= before && at(s) < from))
  }
}

export type Day = { date: Date; seconds: number; sessions: number }

/** Recorded seconds per day for the last `days` days, oldest first, today last. */
export function dailyRecording(sessions: readonly Session[], days: number, now = new Date()): Day[] {
  const today = startOfDay(now)
  const out: Day[] = Array.from({ length: days }, (_, index) => ({
    date: new Date(today - (days - 1 - index) * DAY_MS),
    seconds: 0,
    sessions: 0
  }))
  for (const session of sessions) {
    const time = new Date(session.startedAt)
    if (Number.isNaN(time.getTime())) continue
    const index = days - 1 - Math.round((today - startOfDay(time)) / DAY_MS)
    const day = out[index]
    if (!day) continue
    day.seconds += session.seconds ?? 0
    day.sessions++
  }
  return out
}

/** The most used tags, most first (ties by name), with how many sessions carry each. */
export function topTags(sessions: readonly Session[], limit: number): [string, number][] {
  const counts = new Map<string, number>()
  for (const session of sessions) for (const tag of session.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

/** "1h 02m", "34m", "45s": a duration as a person says it. */
export function durationLabel(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${String(total)}s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${String(minutes)}m`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** "Good morning" until noon, "Good afternoon" until six, then "Good evening". */
export function greeting(now = new Date()): string {
  const hour = now.getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

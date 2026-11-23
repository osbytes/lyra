// Time helpers for the demo. Everything is formatted in UTC with a fixed locale so the server
// render and the browser's first render match exactly (no hydration mismatch).

const MINUTE = 60_000
const HOUR = 3_600_000
export const DAY = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const STARTED = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC'
})
const WEEKDAY_TIME = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC'
})

/** As the app's relativeTime: `Just now`, `5m ago`, `3h ago`, then a date. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.round((now - at) / MINUTE)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return SHORT_DATE.format(at)
}

/** As the app's dayGroup: the sidebar heading a session falls under. */
export function dayGroup(at: number, now: number): string {
  const startOfToday = now - (now % DAY)
  const age = startOfToday - at
  if (age <= 0) return 'Today'
  if (age <= DAY) return 'Yesterday'
  if (age <= 7 * DAY) return 'Previous 7 days'
  if (age <= 30 * DAY) return 'Previous 30 days'
  return MONTH_YEAR.format(at)
}

/** `1:05`, like the app's formatDuration. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** `00:01:05`, the export's transcript timestamps. */
export function hms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** The app's file stem, `2026-11-20_14-03-27`. */
export function stem(at: number): string {
  const d = new Date(at)
  return (
    `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_` +
    `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  )
}

export const formatStarted = (at: number): string => STARTED.format(at)
export const formatWeekdayTime = (at: number): string => WEEKDAY_TIME.format(at)
export const isoDate = (at: number): string => new Date(at).toISOString().slice(0, 10)
export const minutesAgo = (now: number, minutes: number): number => now - minutes * MINUTE
export const hoursAgo = (now: number, hours: number): number => now - hours * HOUR

/**
 * The title a new session starts with, until the user or an AI suggestion replaces it:
 * when it started, as people say it ("Monday morning · Nov 23, 9:14 AM").
 */

/** Minutes either side of 12:00 and 0:00 that read as "noon" and "midnight". */
const ON_THE_HOUR = 15

/** The part of the day, at its most specific. */
export function partOfDay(date: Date): string {
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (Math.abs(minutes - 12 * 60) <= ON_THE_HOUR) return 'noon'
  if (minutes <= ON_THE_HOUR || minutes >= 24 * 60 - ON_THE_HOUR) return 'midnight'
  const hour = date.getHours()
  if (hour < 4) return 'late night'
  if (hour < 7) return 'early morning'
  if (hour < 11) return 'morning'
  if (hour < 14) return 'mid-day'
  if (hour < 17) return 'afternoon'
  if (hour < 20) return 'evening'
  return 'night'
}

// en-US to match the words above: the rest of Lyra's UI is English too.
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' })
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

export function defaultTitle(startedAt: Date): string {
  return `${WEEKDAY.format(startedAt)} ${partOfDay(startedAt)} · ${DAY.format(startedAt)}, ${TIME.format(startedAt)}`
}

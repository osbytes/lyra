const DAY_MS = 86_400_000

/**
 * The time at the right edge of a library row: the clock time today ("10:02"), the weekday
 * within the last week ("Mon"), the date this year ("2 Nov"), and the year before that.
 */
export function rowTime(value: string, now = new Date()): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (time.getTime() >= startOfToday) {
    return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  }
  if (startOfToday - time.getTime() < 6 * DAY_MS) {
    return time.toLocaleDateString('en-US', { weekday: 'short' })
  }
  const day = time.getDate()
  const month = time.toLocaleDateString('en-US', { month: 'short' })
  return time.getFullYear() === now.getFullYear()
    ? `${String(day)} ${month}`
    : `${String(day)} ${month} ${String(time.getFullYear())}`
}

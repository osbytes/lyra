const WORDS_PER_MINUTE = 230

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  const minutes = Math.round((now - time) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const DAY_MS = 86_400_000

/** The sidebar heading a page falls under, by when it was last edited. */
export function dayGroup(value: string, now = new Date()): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return 'Older'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const age = startOfToday - time.getTime()
  if (age <= 0) return 'Today'
  if (age <= DAY_MS) return 'Yesterday'
  if (age <= 7 * DAY_MS) return 'Previous 7 days'
  if (age <= 30 * DAY_MS) return 'Previous 30 days'
  return time.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** Shows a home-relative path as `~/…`; the full path stays in a tooltip. */
export function homePath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~')
}

/** A recording position as `m:ss`, or `h:mm:ss` past an hour. */
export function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return total >= 3600
    ? `${String(Math.floor(m / 60))}:${String(m % 60).padStart(2, '0')}:${s}`
    : `${String(m)}:${s}`
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export const isMac = window.api.platform === 'darwin'

export const shortcutLabel = (key: string, shift = false): string =>
  isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`

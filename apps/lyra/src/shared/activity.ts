/**
 * Activity: every long-running task's progress, ending and error, kept in main
 * (`src/main/activity.ts`) and shown in the sidebar, or the top bar when it's hidden. These are
 * the pure rules both sides share; docs/STATES.md has the reasons.
 */
import { z } from 'zod'

export const ActivityKind = z.enum(['model', 'notes', 'speakers', 'backfill', 'update'])
export type ActivityKind = z.infer<typeof ActivityKind>

/**
 * `running` until it ends `done`, `partial` (some of many failed) or `failed`. `waiting` needs
 * the person to act and isn't an error (an update to install). A cancel removes the item.
 */
export const ActivityState = z.enum(['running', 'waiting', 'done', 'partial', 'failed'])
export type ActivityState = z.infer<typeof ActivityState>

/** What a row offers. `open` is the renderer's own (go to the session); the rest go to main. */
export const ActivityAction = z.enum(['cancel', 'retry', 'install', 'open'])
export type ActivityAction = z.infer<typeof ActivityAction>

/** Which screen shows the detail: an ending isn't announced while that screen is open. */
export const ActivityOrigin = z.enum(['settings', 'session', 'app'])
export type ActivityOrigin = z.infer<typeof ActivityOrigin>

export const ActivityItem = z.strictObject({
  /** Stable per thing: `model:semanticSearch`, `notes:<pageId>`, `backfill`, `update`. */
  id: z.string(),
  kind: ActivityKind,
  state: ActivityState,
  origin: ActivityOrigin,
  /** What is happening or happened, in words: "Downloading the search model". */
  title: z.string(),
  /** A count in a real unit while running ("63 of 150 MB"), the result, or the reason it failed. */
  detail: z.string().nullable(),
  /** The session it belongs to, if any; its title is the renderer's to add. */
  pageId: z.string().nullable(),
  /** 0–1 while running when it can be measured; null otherwise. */
  progress: z.number().min(0).max(1).nullable(),
  actions: z.array(ActivityAction),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** When its ending was seen (its screen was open, or a toast announced it). */
  seenAt: z.number().nullable()
})
export type ActivityItem = z.infer<typeof ActivityItem>

/** A running task joins Activity once it has taken this long: quicker ones only need their control. */
export const ACTIVITY_DELAY_MS = 3000
/** A done item stays this long after it's been seen, so the change is noticed, then goes. */
export const DONE_LINGER_MS = 4000

const ended = (item: ActivityItem): boolean => item.state !== 'running' && item.state !== 'waiting'

/** Whether an item has run its course: done, seen, and past its linger. Main drops these. */
export function expired(item: ActivityItem, now: number): boolean {
  return item.state === 'done' && item.seenAt !== null && now - item.seenAt >= DONE_LINGER_MS
}

/** What Activity shows now, most urgent first: failures, then waiting, running, done. */
export function visibleActivity(items: readonly ActivityItem[], now: number): ActivityItem[] {
  const rank: Record<ActivityState, number> = { failed: 0, partial: 1, waiting: 2, running: 3, done: 4 }
  return items
    .filter((item) => (item.state === 'running' ? now - item.startedAt >= ACTIVITY_DELAY_MS : !expired(item, now)))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.startedAt - b.startedAt)
}

/**
 * What the top-bar button shows when the sidebar is hidden: the most urgent thing, so a
 * failure is never hidden behind a percentage. Null when there's nothing to show.
 */
export type ActivityFace =
  | { tone: 'attention'; label: string; count: number }
  | { tone: 'working'; label: string; progress: number | null; count: number }
  | { tone: 'done'; label: string; count: number }

export function activityFace(visible: readonly ActivityItem[]): ActivityFace | null {
  const count = visible.length
  const attention = visible.filter((item) => item.state === 'failed' || item.state === 'partial' || item.state === 'waiting')
  if (attention.length) {
    const [only] = attention
    const label = attention.length === 1 && only?.state === 'waiting' ? only.title : `${String(attention.length)} need${attention.length === 1 ? 's' : ''} you`
    return { tone: 'attention', label, count }
  }
  const running = visible.filter((item) => item.state === 'running')
  const [first] = running
  if (first) {
    const progress = first.progress
    const label = progress === null ? 'Working' : `${String(Math.floor(progress * 100))}%`
    return { tone: 'working', label: running.length > 1 ? `${label} · ${String(running.length)} tasks` : label, progress, count }
  }
  return count ? { tone: 'done', label: 'Done', count } : null
}

/** Items whose ending just happened: running (or absent) before, ended now. */
export function newEndings(before: ReadonlyMap<string, ActivityItem>, after: readonly ActivityItem[]): ActivityItem[] {
  return after.filter((item) => ended(item) && item.seenAt === null && before.get(item.id)?.state === 'running')
}

/** `63 of 150 MB`: a download's count, in the unit people read. */
export function bytesDetail(received: number, total: number): string {
  const mb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`)
  if (!total) return mb(received)
  const [value, unit] = mb(total).split(' ')
  const done = unit === 'GB' ? (received / 1e9).toFixed(1) : String(Math.round(received / 1e6))
  return `${done} of ${value ?? ''} ${unit ?? ''}`
}

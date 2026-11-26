/**
 * Activity: every long-running task's progress, ending and error, kept here so closing the
 * screen that started it loses nothing (docs/STATES.md). Producers `report()` while working and
 * `end()` with a result or a plain-words reason; windows subscribe to `activity:changed` and ask
 * `activity:list` when they open. Cancel, Retry and Install come back through
 * `onActivityAction()`.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  ActivityAction,
  DONE_LINGER_MS,
  expired,
  type ActivityItem,
  type ActivityKind,
  type ActivityOrigin,
  type ActivityState
} from '../shared/activity'
import { log } from './log'

/** Progress events can come many times a second; windows hear at most this often. */
const BROADCAST_MS = 250

const items = new Map<string, ActivityItem>()
const handlers = new Map<ActivityKind, (item: ActivityItem, action: ActivityAction) => void | Promise<void>>()
let lastSent = 0
let pending: ReturnType<typeof setTimeout> | null = null
let pruneTimer: ReturnType<typeof setTimeout> | null = null

export function activityList(): ActivityItem[] {
  return [...items.values()]
}

function send(): void {
  pending = null
  lastSent = Date.now()
  const list = activityList()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('activity:changed', list)
}

/** Sends now for a change of state; at most every `BROADCAST_MS` for progress alone. */
function broadcast(urgent: boolean): void {
  if (urgent) {
    if (pending) clearTimeout(pending)
    send()
    return
  }
  if (pending) return
  pending = setTimeout(send, Math.max(0, BROADCAST_MS - (Date.now() - lastSent)))
}

/** Drops done items that have been seen long enough, then waits for the next one to go. */
function prune(): void {
  pruneTimer = null
  const now = Date.now()
  let changed = false
  for (const [id, item] of items) {
    if (expired(item, now)) {
      items.delete(id)
      changed = true
    }
  }
  if (changed) broadcast(true)
  const next = [...items.values()].flatMap((item) => (item.state === 'done' && item.seenAt !== null ? [item.seenAt] : []))
  if (next.length) pruneTimer = setTimeout(prune, Math.max(50, Math.min(...next) + DONE_LINGER_MS - now))
}

function schedulePrune(): void {
  pruneTimer ??= setTimeout(prune, DONE_LINGER_MS)
}

export type ActivityReport = {
  id: string
  kind: ActivityKind
  origin: ActivityOrigin
  title: string
  detail?: string | null
  pageId?: string | null
  progress?: number | null
  actions?: ActivityAction[]
}

function put(report: ActivityReport, state: ActivityState): void {
  const before = items.get(report.id)
  const now = Date.now()
  const restarted = !before || (before.state !== 'running' && state === 'running')
  const running = state === 'running' || state === 'waiting'
  const item: ActivityItem = {
    id: report.id,
    kind: report.kind,
    state,
    origin: report.origin,
    title: report.title,
    detail: report.detail ?? null,
    pageId: report.pageId ?? null,
    progress: report.progress === undefined || report.progress === null ? null : Math.min(1, Math.max(0, report.progress)),
    actions: report.actions ?? [],
    startedAt: restarted ? now : before.startedAt,
    endedAt: running ? null : now,
    seenAt: running ? null : (before?.state === state ? before.seenAt : null)
  }
  items.set(report.id, item)
  // A count alone ("64 of 150 MB") is throttled; a new task, phase or ending goes now.
  broadcast(before?.state !== state || before.title !== item.title || state !== 'running')
}

/** A task is working (again): `progress` 0–1 when it can be measured. */
export function report(report: ActivityReport): void {
  put(report, 'running')
}

/** A task needs the person to act, without having failed (an update ready to install). */
export function waiting(report: ActivityReport): void {
  put(report, 'waiting')
}

/** A task ended: `title` says how ("Summary written", "Couldn't write the summary"). */
export function end(report: ActivityReport, state: 'done' | 'partial' | 'failed'): void {
  put(report, state)
  if (state === 'done') schedulePrune()
  if (state === 'failed') log('activity', 'failed', { id: report.id, kind: report.kind })
}

/** A task is gone without an ending to tell (cancelled, or nothing ever started). */
export function clear(id: string): void {
  if (items.delete(id)) broadcast(true)
}

export function activityItem(id: string): ActivityItem | undefined {
  return items.get(id)
}

/** What Cancel, Retry and Install do for one kind of task. */
export function onActivityAction(
  kind: ActivityKind,
  run: (item: ActivityItem, action: ActivityAction) => void | Promise<void>
): void {
  handlers.set(kind, run)
}

/** Endings the person has seen: their screen is open, or a toast announced them. */
export function markSeen(ids: readonly string[]): void {
  const now = Date.now()
  let changed = false
  for (const id of ids) {
    const item = items.get(id)
    if (item?.seenAt !== null || item.state === 'running' || item.state === 'waiting') continue
    items.set(id, { ...item, seenAt: now })
    changed = true
  }
  if (changed) {
    broadcast(true)
    schedulePrune()
  }
}

/** Removes an ended item the person dismissed. A running task is stopped with Cancel, not this. */
export function dismiss(id: string): boolean {
  const item = items.get(id)
  if (!item || item.state === 'running') return false
  items.delete(id)
  broadcast(true)
  return true
}

async function act(id: string, action: ActivityAction): Promise<void> {
  const item = items.get(id)
  if (!item) return
  const run = handlers.get(item.kind)
  if (!run) throw new Error(`Nothing handles ${action} for ${item.kind}`)
  log('activity', 'action', { id, kind: item.kind, action })
  await run(item, action)
}

const Ids = z.array(z.string()).max(200)

export function registerActivity(): void {
  ipcMain.handle('activity:list', () => activityList())
  ipcMain.handle('activity:act', (_event, id: unknown, action: unknown) =>
    act(z.string().parse(id), ActivityAction.exclude(['open']).parse(action))
  )
  ipcMain.handle('activity:dismiss', (_event, id: unknown) => dismiss(z.string().parse(id)))
  ipcMain.handle('activity:seen', (_event, ids: unknown) => {
    markSeen(Ids.parse(ids))
  })
}

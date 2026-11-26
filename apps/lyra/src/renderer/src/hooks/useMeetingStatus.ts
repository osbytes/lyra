import { useSyncExternalStore } from 'react'
import type { MeetingStatus } from '../../../shared/types'

/** How long a finished status ("Speakers labeled") stays before it clears. */
const DONE_MS = 2500

/**
 * Every session's latest processing status, kept for the window's lifetime so switching sessions
 * doesn't lose one that's still running, and the sidebar can show which are busy.
 */
let statuses: ReadonlyMap<string, MeetingStatus> = new Map()
const listeners = new Set<() => void>()
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
let unsubscribe: (() => void) | null = null

function set(pageId: string, status: MeetingStatus | null): void {
  const next = new Map(statuses)
  if (status) next.set(pageId, status)
  else next.delete(pageId)
  statuses = next
  for (const listener of listeners) listener()
}

function receive(status: MeetingStatus): void {
  const timer = clearTimers.get(status.pageId)
  if (timer) clearTimeout(timer)
  clearTimers.delete(status.pageId)
  set(status.pageId, status)
  if (status.state !== 'done') return
  clearTimers.set(
    status.pageId,
    setTimeout(() => {
      clearTimers.delete(status.pageId)
      set(status.pageId, null)
    }, DONE_MS)
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  unsubscribe ??= window.api.onMeetingStatus(receive)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = (): ReadonlyMap<string, MeetingStatus> => statuses

/** Every session's latest processing status, by page id. */
export function useMeetingStatuses(): ReadonlyMap<string, MeetingStatus> {
  return useSyncExternalStore(subscribe, snapshot)
}

/** Latest processing status for `pageId`, cleared a moment after it finishes. */
export function useMeetingStatus(pageId: string | undefined): MeetingStatus | null {
  const all = useMeetingStatuses()
  return pageId === undefined ? null : (all.get(pageId) ?? null)
}

/** Forgets a finished or failed status once the user has closed it. */
export function dismissMeetingStatus(pageId: string): void {
  set(pageId, null)
}

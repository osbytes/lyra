/**
 * Bookkeeping for notes runs, kept free of Electron so it can be unit-tested: one job per
 * session, time limits on model calls, and whether the summary is still the one Lyra wrote.
 */
import { createHash } from 'node:crypto'
import { NotesRun } from '../../shared/sessionDoc'
import type { NotesState } from '../../shared/types'

/** A model call that hasn't answered in this long is treated as hung. */
export const CALL_TIMEOUT_MS = 5 * 60_000

/** Thrown when a newer request for the same session replaced this one. */
export class SupersededError extends Error {
  constructor() {
    super('A newer summary request replaced this one')
    this.name = 'SupersededError'
  }
}

/** A signal that fires when `signal` does or after `ms`, whichever comes first. */
export function callSignal(signal: AbortSignal | undefined, ms = CALL_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** True when an error is the result of an abort or a timeout, not a failure of its own. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export type JobHandle = {
  signal: AbortSignal
  /** Still the newest job for its key (not replaced or cancelled). */
  current(): boolean
  /** Drops the job from the registry, if it is still the current one. */
  finish(): void
}

/**
 * One job per key. Starting a job aborts the one in flight for the same key (with a
 * `SupersededError` as the reason): the newest request has the newest transcript and the user's
 * latest intent, and aborting stops the older call from billing further or writing anything.
 */
export function createJobs(): {
  start(key: string): JobHandle
  cancel(key: string, reason?: Error): boolean
  running(key: string): boolean
} {
  const jobs = new Map<string, AbortController>()
  return {
    start(key) {
      jobs.get(key)?.abort(new SupersededError())
      const controller = new AbortController()
      jobs.set(key, controller)
      return {
        signal: controller.signal,
        current: () => jobs.get(key) === controller && !controller.signal.aborted,
        finish: () => {
          if (jobs.get(key) === controller) jobs.delete(key)
        }
      }
    },
    cancel(key, reason) {
      const controller = jobs.get(key)
      if (!controller) return false
      jobs.delete(key)
      controller.abort(reason ?? new Error('Cancelled'))
      return true
    },
    running: (key) => jobs.has(key)
  }
}

/** Line endings and outer whitespace don't count as an edit. */
export function summaryFingerprint(summary: string): string {
  return createHash('sha256').update(summary.replace(/\r\n?/g, '\n').trim()).digest('hex')
}

/**
 * Whether the user has changed the summary since Lyra last wrote it. An empty summary is never
 * "edited". A summary with no fingerprint was written before Lyra kept one (or typed by hand),
 * so it counts as edited: an automatic run must not risk replacing someone's work.
 */
export function summaryEdited(summary: string, fingerprint: unknown): boolean {
  if (!summary.trim()) return false
  return typeof fingerprint !== 'string' || fingerprint !== summaryFingerprint(summary)
}

export type NotesTrigger = 'auto' | 'manual'

/**
 * Whether a finished run may write its notes. An automatic run writes only over an untouched
 * summary. A manual run was asked to replace the summary as it was when the request came in, so
 * it still writes unless the user changed the summary while the model was working.
 */
export function mayWriteSummary(
  trigger: NotesTrigger,
  now: { summary: string; fingerprint: unknown },
  atStart: string
): boolean {
  switch (trigger) {
    case 'auto':
      return !summaryEdited(now.summary, now.fingerprint)
    case 'manual':
      return now.summary === atStart || !summaryEdited(now.summary, now.fingerprint)
  }
}

/** How a session's notes were made, kept in the session beside the summary. */
export { NotesRun }

/** Notes written before Lyra kept a record were made by the first pipeline. */
const UNRECORDED_PIPELINE = 1

/** Where a session's notes stand against the current pipeline; see `NotesState`. */
export function notesState(
  session: { summary: string; fingerprint: unknown; run: unknown; meeting: boolean },
  pipeline: number
): NotesState {
  if (!session.summary.trim()) return session.meeting ? 'missing' : 'none'
  if (summaryEdited(session.summary, session.fingerprint)) return 'edited'
  const run = NotesRun.safeParse(session.run)
  return (run.success ? run.data.pipeline : UNRECORDED_PIPELINE) < pipeline ? 'outdated' : 'current'
}

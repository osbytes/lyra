/**
 * The decisions a model download makes (resume or restart, retry or give up, when to report
 * progress, whether the disk has room), apart from the network and files so they are unit-tested.
 */

/** What to do with a response to a request for a file from `offset` on. */
export type ResponsePlan =
  /** Write the body after the `offset` bytes already in the `.part` file. */
  | { action: 'append' }
  /** The body is the whole file from byte 0 (the server ignored the range): start the part over. */
  | { action: 'restart' }
  /** The part can't be continued (the server refuses its range): delete it and ask again. */
  | { action: 'discard' }
  /** A passing failure (rate limit, server error): try again after a pause, keeping the part. */
  | { action: 'retry'; reason: string }
  /** Won't get better by asking again (not found, forbidden). */
  | { action: 'fail'; reason: string }

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

export function planResponse(status: number, contentRange: string | null, offset: number, total: number): ResponsePlan {
  if (status === 200) return offset === 0 ? { action: 'append' } : { action: 'restart' }
  if (status === 206) {
    const match = CONTENT_RANGE.exec(contentRange?.trim() ?? '')
    const [, from = '', , size = ''] = match ?? []
    // Anything but the range asked for, of the file pinned, can't be stitched onto the part.
    if (!match || Number(from) !== offset || (size !== '*' && Number(size) !== total)) return { action: 'discard' }
    return { action: 'append' }
  }
  if (status === 416) return { action: 'discard' }
  if (status === 408 || status === 429 || status >= 500) return { action: 'retry', reason: `HTTP ${String(status)}` }
  return { action: 'fail', reason: `HTTP ${String(status)}` }
}

/** Retries after a dropped connection or a stall: 2, 4, 8, 16 s, so a short outage is ridden out. */
export const MAX_RETRIES = 4

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2000 * 2 ** attempt)
}

/**
 * True at most once per `intervalMs`, and always when forced: progress goes to every window over
 * IPC, and a fast connection delivers thousands of network chunks a second.
 */
export function progressThrottle(intervalMs: number, now: () => number = Date.now): (force?: boolean) => boolean {
  let last = -Infinity
  return (force = false) => {
    const at = now()
    if (!force && at - last < intervalMs) return false
    last = at
    return true
  }
}

/**
 * Room kept free beyond the download itself, so a model never fills the disk the notes and
 * recordings are written to.
 */
export const SPACE_MARGIN_BYTES = 64 * 1024 * 1024

/** The bytes short of what a download of `needed` more bytes takes, or 0 when there is room. */
export function spaceShortfall(free: number, needed: number): number {
  return Math.max(0, needed + SPACE_MARGIN_BYTES - free)
}

export function megabytes(bytes: number): string {
  return `${String(Math.ceil(bytes / (1024 * 1024)))} MB`
}

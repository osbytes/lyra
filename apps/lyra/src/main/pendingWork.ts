import { isQuitting } from './lifecycle'
import { log } from './log'
import type { PendingWork } from './sessionManifest'
import { updateManifest } from './sessionStore'

/**
 * The steps a recording still owes its session (`Manifest.pending`): marked when they become due,
 * cleared when they end, so what a quit or crash cut short is resumed at the next start
 * (`resume.ts`). A failure clears its step too: it was reported, and retrying it at every launch
 * would only report it again. Only the quit itself leaves a step owed.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Marks `work` as owed by session `id`. */
export async function owe(id: string, work: readonly PendingWork[]): Promise<void> {
  if (!work.length) return
  await updateManifest(id, (manifest) => ({
    ...manifest,
    pending: [...new Set([...manifest.pending, ...work])]
  })).catch((error: unknown) => {
    log('resume', 'could not mark work as owed', { id, work, error: errorMessage(error) })
  })
}

/**
 * Marks `done` as no longer owed even while quitting: for a step whose own last save says for sure
 * that it is done (a recording stopped for the quit with all of its audio transcribed).
 */
export async function clearOwed(id: string, done: PendingWork): Promise<void> {
  await updateManifest(id, (manifest) => ({
    ...manifest,
    pending: manifest.pending.filter((work) => work !== done)
  })).catch((error: unknown) => {
    log('resume', 'could not mark work as done', { id, done, error: errorMessage(error) })
  })
}

/**
 * Marks `done` as no longer owed, and `next` as owed, in one write: a crash between the two never
 * loses the next step. Does nothing while quitting, when `done` was cut short rather than done.
 */
export async function settle(
  id: string,
  done: PendingWork,
  next: readonly PendingWork[] = []
): Promise<void> {
  if (isQuitting()) return
  await updateManifest(id, (manifest) => ({
    ...manifest,
    pending: [...new Set([...manifest.pending.filter((work) => work !== done), ...next])]
  })).catch((error: unknown) => {
    log('resume', 'could not mark work as done', { id, done, error: errorMessage(error) })
  })
}

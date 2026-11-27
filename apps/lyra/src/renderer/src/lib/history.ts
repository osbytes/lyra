import { log } from './log'

/**
 * Undo and redo for actions outside a session's document: deleting a session or a person,
 * renaming a person, changing a setting. Edits inside a session (title, tags, speakers, lines)
 * undo through the session (`sessionReplica.ts`) instead; App's Ctrl+Z picks whichever of the
 * two happened last.
 */

export type Action = {
  /** Past tense, for the toast: "Deleted “Weekly sync”". */
  label: string
  /** Does the action. Runs when it's performed and again on redo. */
  run: () => Promise<void> | void
  undo: () => Promise<void> | void
  /** What the toast says once undone; "Undid: <label>" if not given. */
  undoneLabel?: string
  /** No toast when done (a settings switch shows its own state); undo and redo still say. */
  quiet?: boolean
}

/** When the action was last done, undone or redone: how Ctrl+Z orders it against document edits. */
type Entry = Action & { at: number }

export type HistoryEvent = {
  kind: 'done' | 'undone' | 'redone'
  label: string
  undoneLabel: string
  quiet: boolean
}

const LIMIT = 100
const past: Entry[] = []
const future: Entry[] = []
const listeners = new Set<(event: HistoryEvent) => void>()

function labels(action: Action): { label: string; undoneLabel: string } {
  return { label: action.label, undoneLabel: action.undoneLabel ?? `Undid: ${action.label}` }
}

function emit(event: HistoryEvent): void {
  for (const listener of listeners) listener(event)
}

/** Does an action and makes it undoable. A failed action isn't recorded. */
export async function perform(action: Action): Promise<void> {
  await action.run()
  past.push({ ...action, at: Date.now() })
  if (past.length > LIMIT) past.shift()
  future.length = 0
  emit({ kind: 'done', ...labels(action), quiet: action.quiet ?? false })
}

/** Records an action that has already happened (e.g. a setting changed by its own control). */
export function record(action: Action): void {
  past.push({ ...action, at: Date.now() })
  if (past.length > LIMIT) past.shift()
  future.length = 0
  emit({ kind: 'done', ...labels(action), quiet: action.quiet ?? false })
}

async function move(from: Entry[], to: Entry[], kind: 'undone' | 'redone'): Promise<boolean> {
  const entry = from.pop()
  if (!entry) return false
  try {
    await (kind === 'undone' ? entry.undo() : entry.run())
  } catch (error) {
    // The thing it acted on changed underneath (a restored session's name was reused): drop it.
    log('history', `could not ${kind === 'undone' ? 'undo' : 'redo'}`, String(error))
    return true
  }
  to.push({ ...entry, at: Date.now() })
  emit({ kind, ...labels(entry), quiet: false })
  return true
}

export const undo = (): Promise<boolean> => move(past, future, 'undone')
export const redo = (): Promise<boolean> => move(future, past, 'redone')

/** When the next undo's action was done, or null when there's nothing to undo. */
export const undoAt = (): number | null => past.at(-1)?.at ?? null
/** When the next redo's action was undone, or null when there's nothing to redo. */
export const redoAt = (): number | null => future.at(-1)?.at ?? null

export function onHistory(listener: (event: HistoryEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

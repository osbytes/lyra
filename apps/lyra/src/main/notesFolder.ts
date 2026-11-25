import { dialog, shell, type BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { MoveNotesResult, Settings } from '../shared/types'
import { log } from './log'
import { checkSessionsDir } from './notePath'
import { moveNotes, notesDir } from './pages'
import { recordingPageId } from './recorder'
import { isRecording } from './session'
import { isRelabeling } from './meeting/relabel'
import { closeAllSessions, flushAllSessions } from './sessionStore'
import { getSettings, updateSettings } from './settings'

/**
 * The notes folder is chosen and changed here, in main, never from a path the renderer sends: a
 * compromised renderer could otherwise point Lyra at any folder (a network share, someone
 * else's files) and have it read, write, move and open things there.
 */

/** The folder notes lived in before the last change, for "Move my sessions there". */
let previousDir: string | null = null

/** Why the folder can't change right now, or null when it can. */
function busyReason(): string | null {
  if (isRecording() || recordingPageId() !== null) {
    return 'Stop the recording before changing the sessions folder.'
  }
  // Relabeling writes into the session's folder for minutes after a recording stops.
  if (isRelabeling()) {
    return 'Wait for speakers to finish being identified before changing the sessions folder.'
  }
  return null
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return info?.isDirectory() ?? false
}

/**
 * Switches the notes folder to `target`, an absolute path to an existing folder: writes and
 * releases the open sessions first, so nothing still being edited is written to the new folder
 * under an old id or lost from the old one.
 */
export async function switchNotesFolder(target: string): Promise<Settings> {
  const busy = busyReason()
  if (busy) throw new Error(busy)
  if (!isAbsolute(target)) throw new Error('The sessions folder must be an absolute path')
  const next = resolve(target)
  const current = resolve(notesDir())
  if (next === current) return getSettings()
  if (!(await isDirectory(next))) throw new Error('The sessions folder must be an existing folder')
  checkSessionsDir(next)
  await flushAllSessions()
  // Release the open documents before their folder changes under them.
  await closeAllSessions()
  const settings = await updateSettings({ notesDir: next })
  previousDir = current
  log('pages', 'sessions folder changed')
  return settings
}

/**
 * Shows the native folder picker and switches to the folder the user picks. Resolves to the new
 * settings, or null when they cancel.
 */
export async function pickNotesFolder(win: BrowserWindow | null): Promise<Settings | null> {
  const busy = busyReason()
  if (busy) throw new Error(busy)
  const options: Electron.OpenDialogOptions = {
    title: 'Choose sessions folder',
    defaultPath: notesDir(),
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const picked = result.canceled ? undefined : result.filePaths[0]
  if (picked === undefined) return null
  return switchNotesFolder(picked)
}

/** Moves the notes from the folder used before the last change into the current one. */
export async function moveFromPreviousFolder(): Promise<MoveNotesResult> {
  const busy = busyReason()
  if (busy) throw new Error(busy)
  const from = previousDir
  if (from === null) return { moved: 0, skipped: 0 }
  const result = await moveNotes(from)
  previousDir = null
  return result
}

/** Opens the notes folder in the file manager, once it is known to be a folder. */
export async function revealNotesFolder(): Promise<void> {
  const dir = notesDir()
  if (!(await isDirectory(dir))) throw new Error('The sessions folder is missing')
  const error = await shell.openPath(dir)
  if (error) throw new Error(error)
}

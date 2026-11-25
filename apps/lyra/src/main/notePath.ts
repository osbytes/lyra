import { lstatSync } from 'node:fs'
import path from 'node:path'

/**
 * Which file names in the notes folder are notes, and where they resolve. Pure (no Electron), so
 * the unit tests can run it with both the POSIX and the Windows path rules.
 */

/** A file name we own: no separators, not hidden, `.txt` or `.md`. */
const NOTE_NAME = /^[^\\/.][^\\/]*\.(txt|md)$/i
/** Windows device names, which open the device instead of a file whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

const hasControl = (name: string): boolean => {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function isNoteName(name: string): boolean {
  if (!NOTE_NAME.test(name) || name.includes('..')) return false
  // `:` names an NTFS alternate data stream (`note.txt:hidden`), so it is never part of a note.
  if (name.includes(':') || hasControl(name)) return false
  // Windows drops trailing dots and spaces, so `a.txt.` would open `a.txt`.
  if (/[. ]$/.test(name)) return false
  const device = (name.split('.')[0] ?? '').trimEnd()
  return !RESERVED.test(device)
}

type PathRules = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'>

/** `id` resolved inside `root`, or an error when it is not a note name directly inside it. */
export function noteInRoot(root: string, id: unknown, rules: PathRules = path): string {
  if (typeof id !== 'string' || !isNoteName(id)) throw new Error('Invalid page id')
  const base = rules.resolve(root)
  const full = rules.resolve(base, id)
  const rel = rules.relative(base, full)
  if (!rel || rel.startsWith('..') || rules.isAbsolute(rel) || rel !== id) {
    throw new Error('Invalid page id')
  }
  return full
}

/** The folder under the notes root that holds each session's document, audio and model passes. */
export const SESSIONS_DIR = '.sessions'

/**
 * Refuses a `.sessions` that is a link (or junction) or not a folder: writing through it would
 * put session data, audio included, wherever the link points.
 */
export function checkSessionsDir(root: string): void {
  const stats = lstatSync(path.join(root, SESSIONS_DIR), { throwIfNoEntry: false })
  if (!stats) return
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${SESSIONS_DIR} in the notes folder is a link or not a folder; Lyra won't write through it`)
  }
}

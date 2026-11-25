import { app, BrowserWindow } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  unlink
} from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { MoveNotesResult, NoteFormat, Page } from '../shared/types'
import { log } from './log'
import { checkSessionsDir, isNoteName, noteInRoot } from './notePath'
import { moveSessionFiles } from './sessionStore'
import { getSettings, onSettingsChanged } from './settings'

export { isNoteName }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
/** A `.txt` first line longer than this is treated as body text, not a title. */
const MAX_TITLE = 200
/** Byte-order mark some editors put at the start of text files. */
const BOM = String.fromCharCode(0xfeff)

export function notesDir(): string {
  return getSettings().notesDir
}

/**
 * Resolves a page id (its file name) inside the notes folder, refusing anything else. Every
 * session path goes through here too (`sessionStore`'s `sessionDir`), so a `.sessions` that has
 * been swapped for a link is refused before anything is written through it.
 */
export function resolveInNotes(id: unknown): string {
  const root = notesDir()
  const full = noteInRoot(root, id)
  checkSessionsDir(root)
  return full
}

function formatOf(id: string): NoteFormat {
  return extname(id).toLowerCase() === '.md' ? 'md' : 'txt'
}

function parseFrontmatter(block: string): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const idx = rawLine.indexOf(':')
    if (idx === -1) continue
    const key = rawLine.slice(0, idx).trim()
    let value = rawLine.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        const parsed: unknown = JSON.parse(value)
        value = typeof parsed === 'string' ? parsed : value.slice(1, -1)
      } catch {
        value = value.slice(1, -1)
      }
    }
    meta[key] = value
  }
  return meta
}

export function serializePage(page: Pick<Page, 'id' | 'title' | 'body' | 'updatedAt'>): string {
  if (formatOf(page.id) === 'txt') {
    const title = page.title.trim()
    // An empty first line means "no title", so the body's first line isn't read back as one.
    if (!title || title === 'Untitled') return `\n${page.body}`
    return `${title.replace(/\r?\n/g, ' ')}\n\n${page.body}`
  }
  return `---\nid: ${page.id}\ntitle: ${JSON.stringify(page.title)}\nupdatedAt: ${page.updatedAt}\n---\n\n${page.body}`
}

/** `.txt`: the first line is the title (blank = untitled), the rest is the body. */
function parseText(raw: string, id: string, mtime: string): Page {
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw
  const [line = ''] = text.split(/\r?\n/, 1)
  const first = line.trim()
  if (!first) {
    const body = text.slice(line.length).replace(/^\r?\n/, '')
    return { id, title: 'Untitled', body, updatedAt: mtime }
  }
  if (first.length > MAX_TITLE) {
    return { id, title: 'Untitled', body: text, updatedAt: mtime }
  }
  const body = text.slice(line.length).replace(/^(?:\r?\n)+/, '')
  return { id, title: first, body, updatedAt: mtime }
}

function parseMarkdown(raw: string, id: string, mtime: string): Page {
  const match = FRONTMATTER.exec(raw)
  if (!match) return { id, title: 'Untitled', body: raw, updatedAt: mtime }
  const meta = parseFrontmatter(match[1] ?? '')
  return {
    id,
    title: meta.title?.trim() ? meta.title : 'Untitled',
    updatedAt: meta.updatedAt?.trim() ? meta.updatedAt : mtime,
    body: raw.slice(match[0].length).replace(/^\r?\n/, '')
  }
}

export function parsePage(raw: string, id: string, mtime = new Date().toISOString()): Page {
  return formatOf(id) === 'md' ? parseMarkdown(raw, id, mtime) : parseText(raw, id, mtime)
}

export async function ensurePagesDir(): Promise<void> {
  await mkdir(notesDir(), { recursive: true })
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-11-20_14-03-27`, in local time; `:` is not allowed in Windows file names. */
export function timestampStem(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}

/** `rename`, falling back to copy + delete when the folders are on different drives. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await unlink(from)
  }
}

/** Moves every note in `fromDir` into the current notes folder, skipping name clashes. */
export async function moveNotes(fromDir: string): Promise<MoveNotesResult> {
  const source = resolve(fromDir)
  const target = resolve(notesDir())
  if (source === target) return { moved: 0, skipped: 0 }
  // Session folders are copied out of the old `.sessions` and into the new one.
  checkSessionsDir(source)
  checkSessionsDir(target)
  await ensurePagesDir()
  let moved = 0
  let skipped = 0
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !isNoteName(entry.name)) continue
    const dest = join(target, entry.name)
    if (existsSync(dest)) {
      skipped++
      continue
    }
    await moveFile(join(source, entry.name), dest)
    await moveSessionFiles(source, entry.name)
    moved++
  }
  log('pages', 'moved notes', { from: source, to: target, moved, skipped })
  return { moved, skipped }
}

/** One-time move of pre-0.2 pages from `userData/pages` into the notes folder. */
export async function migrateLegacyPages(): Promise<void> {
  const legacy = join(app.getPath('userData'), 'pages')
  if (!existsSync(legacy)) return
  try {
    const { moved, skipped } = await moveNotes(legacy)
    if (skipped === 0) {
      await rename(legacy, `${legacy}.migrated`)
    }
    log('pages', 'migrated legacy pages', { moved, skipped, dir: notesDir() })
  } catch (error) {
    log('pages', 'legacy migration failed', String(error))
  }
}

// --- Watching the folder for changes made outside Lyra -----------------------

const OWN_WRITE_MS = 1500
const ownWrites = new Map<string, number>()
let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

export function markOwnWrite(id: string): void {
  ownWrites.set(id, Date.now())
}

/** Tells windows to reload notes after main rewrote one (e.g. a labeled meeting transcript). */
export function notifyPagesChanged(): void {
  broadcastChanged()
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('pages:changed')
}

function onFsEvent(filename: string | null): void {
  if (filename) {
    if (!isNoteName(filename)) return
    const at = ownWrites.get(filename)
    if (at && Date.now() - at < OWN_WRITE_MS) return
  }
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(broadcastChanged, 300)
}

async function restartWatcher(): Promise<void> {
  watcher?.close()
  watcher = null
  try {
    await ensurePagesDir()
    watcher = watch(notesDir(), (_event, filename) => onFsEvent(filename))
    watcher.on('error', (error) => log('pages', 'watcher error', String(error)))
  } catch (error) {
    log('pages', 'could not watch notes folder', String(error))
  }
}

export function startWatchingNotes(): void {
  void restartWatcher()
  onSettingsChanged((next, prev) => {
    if (next.notesDir !== prev.notesDir) {
      void restartWatcher()
      broadcastChanged()
    }
  })
}

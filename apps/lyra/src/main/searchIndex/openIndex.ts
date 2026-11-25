import { createClient, LibsqlError, type Client } from '@libsql/client'
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { prepare, quickCheck } from './db'

/**
 * Opens the index database, and rebuilds it when it's damaged. It's derived data
 * (docs/SEARCH-INDEX.md), so a file that fails to open, fails `quick_check` or fails to prepare
 * is moved aside and started over; the reconcile that follows fills it from the notes folder.
 * Left as it is, it would fail the same way on every launch.
 */

/**
 * Failures that say nothing about the file (locked, disk full, no permission): moving it aside
 * would throw away the stored vectors for nothing, so these are left to a later retry.
 */
const TRANSIENT = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_NOMEM', 'SQLITE_PERM', 'SQLITE_READONLY']

function isTransient(error: unknown): boolean {
  return error instanceof LibsqlError && TRANSIENT.some((code) => error.code.startsWith(code))
}

/** A file that can't be renamed yet (Windows holds it a moment after close) gets a few tries. */
const MOVE_TRIES = 5
const MOVE_GAP_MS = 200

export type OpenedIndex = { client: Client; fresh: boolean; recovered: boolean }

async function openChecked(path: string, notesDir: string): Promise<{ client: Client; fresh: boolean }> {
  // A real file URL: a plain `file:` + path breaks on a '#' or '%' in it (a user name).
  const client = createClient({ url: pathToFileURL(path).href })
  try {
    const problem = await quickCheck(client)
    if (problem) throw new Error(`quick_check: ${problem}`)
    return { client, fresh: await prepare(client, notesDir) }
  } catch (error) {
    client.close()
    throw error
  }
}

async function moveAside(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= MOVE_TRIES) throw error
      await sleep(MOVE_GAP_MS * attempt)
    }
  }
}

/**
 * Moves `lyra.db` and its WAL files aside as `*.corrupt-<time>`, keeping only the newest such
 * set: one is enough to look at, and each can be as large as the index.
 */
async function quarantine(path: string): Promise<void> {
  const dir = dirname(path)
  const name = basename(path)
  for (const file of readdirSync(dir)) {
    if (file.startsWith(name) && file.includes('.corrupt-')) unlinkSync(join(dir, file))
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path + suffix
    if (existsSync(file)) await moveAside(file, `${file}.corrupt-${stamp}`)
  }
}

export async function openIndex(
  path: string,
  notesDir: string,
  onDamaged: (error: unknown) => void = () => undefined
): Promise<OpenedIndex> {
  mkdirSync(dirname(path), { recursive: true })
  try {
    return { ...(await openChecked(path, notesDir)), recovered: false }
  } catch (error) {
    if (isTransient(error)) throw error
    onDamaged(error)
  }
  await quarantine(path)
  return { ...(await openChecked(path, notesDir)), fresh: true, recovered: true }
}

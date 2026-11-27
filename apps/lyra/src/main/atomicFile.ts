import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Durable file replacement: write a temp file beside the target, fsync it, then rename it over
 * the target. A crash leaves either the old file or the new one, never a torn mix, and the
 * fsync keeps the rename from landing before the data does (which some file systems allow).
 */

/**
 * Unique per write, so two overlapping writes of one file never share a temp file. Hidden
 * (leading dot) and not ending in `.txt`/`.md`, so the notes watcher and sync clients skip it.
 */
export function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
}

/** A file-name-safe timestamp for copies set aside (`doc.json.corrupt-<stamp>`). */
export function asideStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Windows refuses to rename over a file that anything has open at that instant: antivirus, a sync
 * client, the search indexer, or another write of the same file landing just before. It clears
 * in milliseconds, so the rename gets a few tries there. Elsewhere these codes mean a real
 * permission problem and are reported at once.
 */
const RENAME_TRIES = 8
const RENAME_FIRST_GAP_MS = 5

function isSharingViolation(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = error instanceof Error && 'code' in error ? error.code : null
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function renameOver(temp: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      if (attempt >= RENAME_TRIES || !isSharingViolation(error)) throw error
      await sleep(RENAME_FIRST_GAP_MS * 2 ** (attempt - 1))
    }
  }
}

function renameOverSync(temp: string, path: string): void {
  // Blocks the thread, which is the point of a sync write; a few short waits, well under a second.
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (error) {
      if (attempt >= RENAME_TRIES || !isSharingViolation(error)) throw error
      Atomics.wait(pause, 0, 0, RENAME_FIRST_GAP_MS * 2 ** (attempt - 1))
    }
  }
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = tempPathFor(path)
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameOver(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export function writeFileAtomicSync(path: string, data: string | Uint8Array): void {
  const temp = tempPathFor(path)
  try {
    const fd = openSync(temp, 'wx')
    try {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      let written = 0
      while (written < bytes.byteLength) {
        written += writeSync(fd, bytes, written, bytes.byteLength - written)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameOverSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Never created, or already renamed.
    }
    throw error
  }
}

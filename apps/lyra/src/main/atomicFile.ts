import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

/** A file-name-safe timestamp for copies set aside (`doc.yjs.corrupt-<stamp>`). */
export function asideStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
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
    await rename(temp, path)
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
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Never created, or already renamed.
    }
    throw error
  }
}

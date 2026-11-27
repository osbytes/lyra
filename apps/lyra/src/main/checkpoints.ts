import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import { writeFileAtomic } from './atomicFile'
import { log } from './log'
import { sessionCheckpointDir } from './sessionStore'

/**
 * What a long step has worked out so far, in `.sessions/<id>/checkpoint/<name>.json`, so a quit,
 * crash or failure part way through doesn't throw it away: the diarization of a whole recording
 * (`meeting/relabel.ts`), the model's answers for a long meeting's summary (`meeting/notes.ts`).
 * Derived data, deleted once the step is done; losing it only costs the time to redo the work.
 * Each checkpoint says what it was worked out from (a key), and one for other input is ignored.
 */

export type CheckpointName = 'diarize' | 'notes'

const pathOf = (id: string, name: CheckpointName): string => join(sessionCheckpointDir(id), `${name}.json`)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The checkpoint, or null when there is none or it doesn't read as `schema`. */
export async function readCheckpoint<T>(
  id: string,
  name: CheckpointName,
  schema: z.ZodType<T>
): Promise<T | null> {
  let text: string
  try {
    text = await readFile(pathOf(id, name), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    if (parsed.success) return parsed.data
  } catch {
    // Not JSON: written by something else, or torn by a disk that ignores fsync.
  }
  log('checkpoint', 'ignored an unreadable checkpoint', { id, name })
  return null
}

/** Replaces the checkpoint atomically; a failure is logged, never thrown (it only costs a redo). */
export async function writeCheckpoint(id: string, name: CheckpointName, value: unknown): Promise<void> {
  try {
    await mkdir(sessionCheckpointDir(id), { recursive: true })
    await writeFileAtomic(pathOf(id, name), JSON.stringify(value))
  } catch (error) {
    log('checkpoint', 'could not save a checkpoint', { id, name, error: errorMessage(error) })
  }
}

export async function clearCheckpoint(id: string, name: CheckpointName): Promise<void> {
  await rm(pathOf(id, name), { force: true }).catch((error: unknown) => {
    log('checkpoint', 'could not delete a checkpoint', { id, name, error: errorMessage(error) })
  })
}

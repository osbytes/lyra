/** Messages between the main process (notesLocal.ts) and the local notes worker (notesWorker.ts). */
import { z } from 'zod'

export const NotesWorkerRequest = z.discriminatedUnion('kind', [
  /** Meeting notes for a whole transcript; the worker splits and merges it to fit the model. */
  z.object({ kind: z.literal('notes'), id: z.number(), modelPath: z.string(), transcript: z.string() }),
  z.object({ kind: z.literal('title'), id: z.number(), modelPath: z.string(), text: z.string() }),
  /** Stops request `id`, running or queued. */
  z.object({ kind: z.literal('cancel'), id: z.number() }),
  /** Frees the model's memory once the queued work is done (a recording is starting). */
  z.object({ kind: z.literal('release') })
])
export type NotesWorkerRequest = z.infer<typeof NotesWorkerRequest>

export const NotesWorkerResponse = z.discriminatedUnion('ok', [
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() })
])
export type NotesWorkerResponse = z.infer<typeof NotesWorkerResponse>

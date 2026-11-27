/** Messages between the main process (notesLocal.ts) and the local notes worker (notesWorker.ts). */
import { z } from 'zod'
import { NotesLine } from './notesFormat'

export const NotesWorkerRequest = z.discriminatedUnion('kind', [
  /** Meeting notes for a whole transcript; the worker cuts it into sections to fit the model. */
  z.object({
    kind: z.literal('notes'),
    id: z.number(),
    modelPath: z.string(),
    lines: z.array(NotesLine),
    /** Answers an earlier, unfinished try already got, by call (`NotesAnswers`). */
    known: z.record(z.string(), z.unknown())
  }),
  z.object({ kind: z.literal('title'), id: z.number(), modelPath: z.string(), text: z.string() }),
  /** Stops request `id`, running or queued. */
  z.object({ kind: z.literal('cancel'), id: z.number() }),
  /** Frees the model's memory once the queued work is done (a recording is starting). */
  z.object({ kind: z.literal('release') })
])
export type NotesWorkerRequest = z.infer<typeof NotesWorkerRequest>

export const NotesWorkerResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('result'), id: z.number(), result: z.unknown() }),
  z.object({ kind: z.literal('error'), id: z.number(), error: z.string() }),
  /** Model calls done of those planned for request `id`; more messages follow. */
  z.object({ kind: z.literal('progress'), id: z.number(), done: z.number(), total: z.number() }),
  /** A model call of request `id` answered: main keeps it, so a retry needn't ask again. */
  z.object({ kind: z.literal('answer'), id: z.number(), key: z.string(), answer: z.unknown() })
])
export type NotesWorkerResponse = z.infer<typeof NotesWorkerResponse>

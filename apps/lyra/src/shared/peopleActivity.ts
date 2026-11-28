import { z } from 'zod'

/**
 * What the People pages are built from: every session someone spoke in, read from the search
 * index. Someone is a speaker linked to a saved voice or given a name; "Speaker 2" is nobody yet.
 */
export const PeopleActivity = z.object({
  /** Sessions with at least one such speaker in them, newest first. */
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      startedAt: z.string(),
      seconds: z.number().nullable(),
      /** Everyone's talk time in the session, saved people or not. */
      talkSeconds: z.number(),
      tags: z.array(z.string())
    })
  ),
  /** One per speaker per session; the renderer works out who each one is. */
  appearances: z.array(
    z.object({
      sessionId: z.string(),
      /** The saved voice they're linked to; null for a speaker only given a name. */
      personId: z.string().nullable(),
      name: z.string(),
      talkSeconds: z.number(),
      lines: z.number().int(),
      words: z.number().int()
    })
  ),
  /** Meeting-note action items with an owner, from those sessions. */
  actionItems: z.array(
    z.object({ sessionId: z.string(), owner: z.string(), task: z.string(), done: z.boolean() })
  )
})
export type PeopleActivity = z.infer<typeof PeopleActivity>

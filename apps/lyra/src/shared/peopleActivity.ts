import { z } from 'zod'

/**
 * What the People pages are built from: every session a saved person spoke in, read from the
 * search index. Only speakers linked to a saved person count; a speaker named by hand without
 * saving their voice has no person to count toward.
 */
export const PeopleActivity = z.object({
  /** Sessions with at least one saved person in them, newest first. */
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
  /** One per person per session (a person heard as two speakers is summed). */
  appearances: z.array(
    z.object({
      sessionId: z.string(),
      personId: z.string(),
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

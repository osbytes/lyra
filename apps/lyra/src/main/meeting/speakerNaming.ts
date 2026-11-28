import { log } from '../log'
import { editSession, readSession } from '../sessionStore'
import { listPeople } from '../voices'
import type { NotesWriter } from './notesWriter'
import { introduceSpeakers, namesFrom, speakerTranscript } from './speakerNames'

/**
 * Asks the notes model who a session's unnamed speakers are, and names them as a guess for the
 * user to confirm (`speakerNames.ts`). Runs once a recording is labeled, before its summary, so
 * the summary uses the names; with the writer the user chose for summaries, so it never runs with
 * them off, sends the transcript only where summaries already go, and never starts the local
 * model's download. A failure is logged and skipped: the summary still follows. Resolves to how
 * many speakers it named.
 */
export async function suggestSpeakerNames(pageId: string, writer: NotesWriter, signal?: AbortSignal): Promise<number> {
  try {
    if (!(await writer.canTitle())) return 0
    const view = speakerTranscript(await readSession(pageId))
    if (!view) return 0
    const started = Date.now()
    const answer = await writer.speakers(view.text, signal)
    const found = namesFrom(answer, view)
    const people = found.size ? await listPeople() : []
    // Applied to the session as it is now: `introduceSpeakers` checks each finding again.
    const named = found.size ? await editSession(pageId, (doc) => introduceSpeakers(doc, found, people)) : 0
    log('speakers', 'names from the transcript', {
      pageId,
      writer: writer.name,
      unnamed: view.labels.size,
      // What the model said, and what of it held up (`namesFrom`).
      answered: answer.speakers.length,
      found: found.size,
      named,
      ms: Date.now() - started
    })
    return named
  } catch (error) {
    log('speakers', 'naming from the transcript failed', {
      pageId,
      writer: writer.name,
      error: error instanceof Error ? error.message : String(error)
    })
    return 0
  }
}

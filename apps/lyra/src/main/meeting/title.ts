import type { SessionSnapshot } from '../../shared/sessionDoc'
import { log } from '../log'
import { onRecordingFinished } from '../recorder'
import { peekManifest, readSession, setAutoTitle } from '../sessionStore'
import { transcriptLines } from './notesChunks'
import type { NotesWriter } from './notesWriter'

/** Fewer words than this say too little to name. */
const MIN_WORDS = 12
/** A title needs the gist, not the whole meeting: the start of a long session is plenty. */
const MAX_CHARS = 20_000

/**
 * What the title is made from: the transcript as `Name: text` lines, with the user's typed notes
 * first only when the writer is on this computer. Settings tells people that a summary provider
 * receives the transcript; what they typed stays home.
 */
function sessionText(snapshot: SessionSnapshot, onDevice: boolean): string {
  const typed = onDevice ? snapshot.notes.trim() : ''
  return [typed, transcriptLines(snapshot)].filter(Boolean).join('\n\n').slice(0, MAX_CHARS)
}

export type TitleService = {
  /**
   * Asks the writer the user chose for a title, and sets it while the title is still Lyra's own
   * (the start time, or an earlier suggestion). Never runs with summaries off, and never starts the
   * local model's download on its own. One request per session at a time (a second is ignored);
   * the writer bounds each call with a timeout and an output cap.
   */
  suggestTitle(pageId: string): Promise<void>
  /** Suggests a title after each recording, from what was said and written so far. */
  register(): void
}

export function createTitleSuggestions(deps: { writer: () => Promise<NotesWriter | null> }): TitleService {
  const running = new Set<string>()

  async function suggestTitle(pageId: string): Promise<void> {
    if (running.has(pageId) || peekManifest(pageId)?.titleAuto === false) return
    running.add(pageId)
    let writer: NotesWriter | null = null
    try {
      writer = await deps.writer()
      if (!writer || !(await writer.canTitle())) return
      const text = sessionText(await readSession(pageId), writer.onDevice)
      if ((text.match(/\S+/g)?.length ?? 0) < MIN_WORDS) return
      const title = await writer.title(text)
      if (!title) return
      const set = await setAutoTitle(pageId, title)
      log('title', set ? 'suggested' : 'kept the user’s title', { pageId, writer: writer.name })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('title', 'suggestion failed', { pageId, writer: writer?.name ?? null, error: message })
    } finally {
      running.delete(pageId)
    }
  }

  return {
    suggestTitle,
    register() {
      onRecordingFinished((recording) => {
        void suggestTitle(recording.pageId)
      })
    }
  }
}

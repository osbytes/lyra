import type { SessionSnapshot } from '../../shared/sessionDoc'
import { log } from '../log'
import { onRecordingFinished } from '../recorder'
import { getClaudeKey } from '../secrets'
import { peekManifest, readSession, setAutoTitle } from '../sessionStore'
import { getSettings } from '../settings'
import { claudeTitle } from './notesClaude'
import { hasLocalNotesModel, localTitle } from './notesLocal'

/** Fewer words than this say too little to name. */
const MIN_WORDS = 12
/** A title needs the gist, not the whole meeting: the start of a long session is plenty. */
const MAX_CHARS = 20_000

/** What the session says: the user's notes, then the transcript as `Name: text` lines. */
function sessionText(snapshot: SessionSnapshot): string {
  const names = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.name]))
  const lines = snapshot.transcript.map((segment) => {
    const name = segment.cluster ? (names.get(segment.cluster) ?? 'Speaker') : 'Speaker'
    return `${name}: ${segment.text}`
  })
  return [snapshot.notes.trim(), lines.join('\n')].filter(Boolean).join('\n\n').slice(0, MAX_CHARS)
}

const running = new Set<string>()

/**
 * Asks the notes engine the user chose for a title, and sets it while the title is still Lyra's
 * own (the start time, or an earlier suggestion). Never runs with notes off, and never starts the
 * local model's download on its own.
 */
export async function suggestTitle(pageId: string): Promise<void> {
  const engine = getSettings().notesEngine
  if (engine === 'off' || running.has(pageId) || peekManifest(pageId)?.titleAuto === false) return
  running.add(pageId)
  try {
    const text = sessionText(await readSession(pageId))
    if ((text.match(/\S+/g)?.length ?? 0) < MIN_WORDS) return
    let title: string | null
    if (engine === 'claude') {
      const key = await getClaudeKey()
      if (!key) return
      title = await claudeTitle(key, text)
    } else {
      if (!hasLocalNotesModel()) return
      title = await localTitle(text)
    }
    if (!title) return
    const set = await setAutoTitle(pageId, title)
    log('title', set ? 'suggested' : 'kept the user’s title', { pageId, engine })
  } catch (error) {
    log('title', 'suggestion failed', { pageId, engine, error: error instanceof Error ? error.message : String(error) })
  } finally {
    running.delete(pageId)
  }
}

/** Suggests a title after each recording, from what was said and written so far. */
export function registerTitleSuggestions(): void {
  onRecordingFinished((recording) => {
    void suggestTitle(recording.pageId)
  })
}

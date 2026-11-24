import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { MeetingStatus } from '../../shared/types'
import { log } from '../log'
import { editDoc, type SessionSnapshot } from '../../shared/sessionDoc'
import { editSession, readSession } from '../sessionStore'
import { renderNotes } from './notesFormat'
import type { NotesWriter } from './notesWriter'
import { onMeetingLabeled } from './events'

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

/** The transcript as `Name: text` lines, the shape the notes prompts expect. */
function transcriptText(snapshot: SessionSnapshot): string {
  const names = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.name]))
  return snapshot.transcript
    .map((segment) => {
      const name = segment.cluster ? (names.get(segment.cluster) ?? 'Speaker') : 'Speaker'
      return `${name}: ${segment.text}`
    })
    .join('\n')
}

export type MeetingNotesService = {
  /** Writes (or rewrites) a session's generated notes (its summary, above the user's notes). */
  generateNotes(pageId: string): Promise<void>
  /** Generates notes after each labeled meeting, and answers the renderer's requests. */
  register(): void
}

/** `writer` is the one the user chose, or null when summaries are off (writers.ts). */
export function createMeetingNotes(deps: { writer: () => Promise<NotesWriter | null> }): MeetingNotesService {
  async function generateNotes(pageId: string): Promise<void> {
    const status = (state: MeetingStatus['state'], progress: number, message?: string): void => {
      broadcast({ pageId, state, progress, ...(message ? { message } : {}) })
    }
    let writer: NotesWriter | null = null
    try {
      writer = await deps.writer()
      if (!writer) throw new Error('Summaries are turned off in Settings → Sessions')
      const transcript = transcriptText(await readSession(pageId))
      if (!transcript.trim()) throw new Error('This note has no transcript to summarize')
      status('summarizing', 0)
      const started = Date.now()
      const notes = await writer.notes(transcript, (received, total) => {
        status('downloading', total ? received / total : 0, 'notes model')
      })
      // Only the summary changes, so edits made while the model worked are untouched.
      await editSession(pageId, (doc) => {
        editDoc(doc, { summary: renderNotes(notes) }, 'notes')
      })
      log('notes', 'generated', { pageId, writer: writer.name, ms: Date.now() - started })
      status('done', 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('notes', 'failed', { pageId, writer: writer?.name ?? null, error: message })
      status('error', 0, message)
      throw error
    }
  }

  return {
    generateNotes,
    register() {
      onMeetingLabeled((pageId) => {
        void deps.writer().then(
          (writer) => {
            if (!writer) return
            generateNotes(pageId).catch(() => {
              // Already reported through meeting:status and the log.
            })
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            log('notes', 'not generated', { pageId, error: message })
          }
        )
      })
      ipcMain.handle('notes:generate', (_event, pageId: unknown) => generateNotes(z.string().parse(pageId)))
    }
  }
}

import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { MeetingStatus } from '../../shared/types'
import { log } from '../log'
import { docMeta, docSummary, editDoc, snapshotOf } from '../../shared/sessionDoc'
import { changeSession, editSession } from '../sessionStore'
import { transcriptLines } from './notesChunks'
import { renderNotes } from './notesFormat'
import {
  createJobs,
  GENERATED_SUMMARY_KEY,
  isAbort,
  mayWriteSummary,
  SupersededError,
  summaryEdited,
  summaryFingerprint,
  type NotesTrigger
} from './notesJobs'
import type { NotesWriter } from './notesWriter'
import { onMeetingLabeled } from './events'

const ORIGIN_NOTES = 'notes'

/**
 * Notes share the meeting status channel with speaker labeling. When `MeetingStatus` gains a
 * `task` field, it is set here (`task: 'notes'`) and nowhere else.
 */
function broadcast(pageId: string, state: MeetingStatus['state'], progress: number, message?: string): void {
  const status: MeetingStatus = { pageId, task: 'notes', state, progress, ...(message ? { message } : {}) }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

export type MeetingNotesService = {
  /**
   * Writes (or rewrites) a session's generated notes (its summary, above the user's notes).
   * `manual` (the default: the Write/Rewrite summary button, the meeting task) always replaces
   * the summary; `auto` (after a recording is labeled) only when the user hasn't edited it.
   * A newer request for the same session replaces one in flight (see `createJobs`).
   */
  generateNotes(pageId: string, trigger?: NotesTrigger): Promise<void>
  /** Whether the summary was changed since Lyra wrote it, so a rewrite would lose edits. */
  summaryEdited(pageId: string): Promise<boolean>
  /** Stops a session's notes run, if one is going; returns whether one was. */
  cancel(pageId: string): boolean
  /** Generates notes after each labeled meeting, and answers the renderer's requests. */
  register(): void
}

/** The session as notes need it, plus the fingerprint of the summary Lyra last wrote. */
function readForNotes(pageId: string): Promise<{ transcript: string; summary: string; fingerprint: unknown }> {
  return changeSession(pageId, (doc) => {
    const snapshot = snapshotOf(doc)
    return {
      transcript: transcriptLines(snapshot),
      summary: snapshot.summary,
      fingerprint: docMeta(doc).get(GENERATED_SUMMARY_KEY)
    }
  })
}

/** `writer` is the one the user chose, or null when summaries are off (writers.ts). */
export function createMeetingNotes(deps: { writer: () => Promise<NotesWriter | null> }): MeetingNotesService {
  const jobs = createJobs()

  async function generateNotes(pageId: string, trigger: NotesTrigger = 'manual'): Promise<void> {
    const before = await readForNotes(pageId)
    // Checked before taking the session's slot, so a skipped run never cancels a real one.
    if (trigger === 'auto' && summaryEdited(before.summary, before.fingerprint)) {
      log('notes', 'kept the edited summary', { pageId })
      return
    }
    const job = jobs.start(pageId)
    let writer: NotesWriter | null = null
    try {
      writer = await deps.writer()
      if (!writer) throw new Error('Summaries are turned off in Settings → Sessions')
      if (!before.transcript.trim()) throw new Error('This note has no transcript to summarize')
      broadcast(pageId, 'summarizing', 0)
      const started = Date.now()
      const notes = await writer.notes(before.transcript, {
        signal: job.signal,
        onDownload: (received, total) => {
          broadcast(pageId, 'downloading', total ? received / total : 0, 'notes model')
        }
      })
      // A writer that finished despite an abort still mustn't write; the catch reports why.
      job.signal.throwIfAborted()
      const summary = renderNotes(notes)
      // Only the summary changes, so edits made elsewhere while the model worked are untouched.
      const written = await editSession(pageId, (doc) => {
        const now = { summary: docSummary(doc).toJSON(), fingerprint: docMeta(doc).get(GENERATED_SUMMARY_KEY) }
        if (!mayWriteSummary(trigger, now, before.summary)) return false
        doc.transact(() => {
          editDoc(doc, { summary }, ORIGIN_NOTES)
          docMeta(doc).set(GENERATED_SUMMARY_KEY, summaryFingerprint(summary))
        }, ORIGIN_NOTES)
        return true
      })
      log('notes', written ? 'generated' : 'kept the summary edited during the run', {
        pageId,
        trigger,
        writer: writer.name,
        ms: Date.now() - started
      })
      if (written || trigger === 'auto') broadcast(pageId, 'done', 1)
      else broadcast(pageId, 'error', 0, 'The summary was edited while it was being written, so it was kept')
    } catch (error) {
      // A newer request took over; it reports its own status.
      if (job.signal.reason instanceof SupersededError) {
        log('notes', 'replaced by a newer request', { pageId, writer: writer?.name ?? null })
        return
      }
      const message =
        job.signal.aborted && job.signal.reason instanceof Error
          ? job.signal.reason.message
          : error instanceof Error
            ? error.message
            : String(error)
      log('notes', 'failed', { pageId, trigger, writer: writer?.name ?? null, error: message, aborted: isAbort(error) })
      broadcast(pageId, 'error', 0, message)
      throw error
    } finally {
      job.finish()
    }
  }

  async function edited(pageId: string): Promise<boolean> {
    const { summary, fingerprint } = await readForNotes(pageId)
    return summaryEdited(summary, fingerprint)
  }

  return {
    generateNotes,
    summaryEdited: edited,
    cancel: (pageId) => jobs.cancel(pageId, new Error('Summary stopped')),
    register() {
      onMeetingLabeled((pageId) => {
        void deps.writer().then(
          (writer) => {
            if (!writer) return
            generateNotes(pageId, 'auto').catch(() => {
              // Already reported through meeting:status and the log.
            })
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            log('notes', 'not generated', { pageId, error: message })
          }
        )
      })
      ipcMain.handle('notes:generate', (_event, pageId: unknown) => generateNotes(z.string().parse(pageId), 'manual'))
      ipcMain.handle('notes:summaryEdited', (_event, pageId: unknown) => edited(z.string().parse(pageId)))
      ipcMain.handle('notes:cancel', (_event, pageId: unknown) => jobs.cancel(z.string().parse(pageId), new Error('Summary stopped')))
    }
  }
}

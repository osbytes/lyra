import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type {
  MeetingStatus,
  NotesBackfill,
  NotesBackfillKind,
  NotesBackfillResult,
  NotesState
} from '../../shared/types'
import { log } from '../log'
import { docMeta, docSummary, editDoc, snapshotOf } from '../../shared/sessionDoc'
import { changeSession, editSession, listSessions } from '../sessionStore'
import { notesLinesOf } from './notesChunks'
import { renderNotes, type NotesLine } from './notesFormat'
import {
  createJobs,
  GENERATED_SUMMARY_KEY,
  isAbort,
  mayWriteSummary,
  NOTES_RUN_KEY,
  notesState,
  SupersededError,
  summaryEdited,
  summaryFingerprint,
  type NotesRun,
  type NotesTrigger
} from './notesJobs'
import { NOTES_PIPELINE } from './notesPipeline'
import type { NotesWriter } from './notesWriter'
import { onMeetingLabeled } from './events'
import { reportMeetingStatus, SUMMARY_KEPT, SUMMARY_STOPPED } from './meetingActivity'
import { clear as clearActivity, end as endActivity, onActivityAction, report as reportActivity } from '../activity'

const ORIGIN_NOTES = 'notes'

/**
 * Notes share the meeting status channel with speaker labeling. When `MeetingStatus` gains a
 * `task` field, it is set here (`task: 'notes'`) and nowhere else.
 */
function broadcast(pageId: string, state: MeetingStatus['state'], progress: number, message?: string, announce = false): void {
  const status: MeetingStatus = { pageId, task: 'notes', state, progress, ...(message ? { message } : {}) }
  reportMeetingStatus(status, announce)
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
  /** How many sessions a bulk run would write notes for, and how many it leaves alone. */
  backfillStatus(): Promise<NotesBackfill>
  /**
   * Writes notes, one session at a time with the current writer: for every session whose notes
   * an older pipeline made (and nobody edited since), or for every meeting that has none.
   */
  backfill(kind: NotesBackfillKind): Promise<NotesBackfillResult>
  /** Stops a bulk run on the session it is on; returns whether one was going. */
  stopBackfill(): boolean
  /** Generates notes after each labeled meeting, and answers the renderer's requests. */
  register(): void
}

/** The session as notes need it, plus the fingerprint of the summary Lyra last wrote. */
function readForNotes(pageId: string): Promise<{ lines: NotesLine[]; summary: string; fingerprint: unknown }> {
  return changeSession(pageId, (doc) => {
    const snapshot = snapshotOf(doc)
    return {
      lines: notesLinesOf(snapshot),
      summary: snapshot.summary,
      fingerprint: docMeta(doc).get(GENERATED_SUMMARY_KEY)
    }
  })
}

/** Where a session's notes stand against the current pipeline (see `notesState`). */
function stateOf(pageId: string): Promise<NotesState> {
  return changeSession(pageId, (doc) => {
    const snapshot = snapshotOf(doc)
    const meta = docMeta(doc)
    return notesState(
      {
        summary: snapshot.summary,
        fingerprint: meta.get(GENERATED_SUMMARY_KEY),
        run: meta.get(NOTES_RUN_KEY),
        // Notes are written on their own for labeled meetings only, so only those miss them.
        meeting: snapshot.transcript.some((line) => line.cluster !== null)
      },
      NOTES_PIPELINE
    )
  })
}

/** Every session by where its notes stand; one that can't be read is left out. */
async function survey(): Promise<Record<NotesState, string[]>> {
  const found: Record<NotesState, string[]> = { current: [], outdated: [], edited: [], missing: [], none: [] }
  for (const { id } of await listSessions()) {
    try {
      found[await stateOf(id)].push(id)
    } catch (error) {
      log('notes', 'skipped a session it could not read', { pageId: id, error: String(error) })
    }
  }
  return found
}

/** The bulk run's one Activity row, read back by Settings so its result outlives the dialog. */
export const BACKFILL_ACTIVITY = 'backfill'

const BACKFILL_WORDS: Record<NotesBackfillKind, { running: string; done: string; failed: string }> = {
  outdated: { running: 'Rewriting older summaries', done: 'Rewrote', failed: "Couldn't rewrite summaries" },
  missing: { running: 'Writing missing summaries', done: 'Wrote', failed: "Couldn't write summaries" }
}

/** `writer` is the one the user chose, or null when summaries are off (writers.ts). */
export function createMeetingNotes(deps: { writer: () => Promise<NotesWriter | null> }): MeetingNotesService {
  const jobs = createJobs()
  /** The bulk run going, if any: whether it was asked to stop, and the session it is on. */
  let backfilling: { stop: AbortController; pageId: string | null } | null = null

  /** Writes a session's notes; resolves to whether they were written. */
  async function generateNotes(pageId: string, trigger: NotesTrigger = 'manual'): Promise<boolean> {
    const before = await readForNotes(pageId)
    // Checked before taking the session's slot, so a skipped run never cancels a real one.
    if (trigger === 'auto' && summaryEdited(before.summary, before.fingerprint)) {
      log('notes', 'kept the edited summary', { pageId })
      return false
    }
    const job = jobs.start(pageId)
    let writer: NotesWriter | null = null
    try {
      writer = await deps.writer()
      if (!writer) throw new Error('Summaries are turned off in Settings → Sessions')
      if (!before.lines.length) throw new Error('This note has no transcript to summarize')
      broadcast(pageId, 'summarizing', 0)
      const started = Date.now()
      const notes = await writer.notes(before.lines, {
        signal: job.signal,
        onProgress: (done, total) => {
          broadcast(pageId, 'summarizing', total ? done / total : 0, total > 1 ? `step ${String(done)} of ${String(total)}` : undefined)
        },
        onDownload: (received, total) => {
          broadcast(pageId, 'downloading', total ? received / total : 0, 'notes model')
        }
      })
      // A writer that finished despite an abort still mustn't write; the catch reports why.
      job.signal.throwIfAborted()
      const summary = renderNotes(notes)
      const run: NotesRun = { pipeline: NOTES_PIPELINE, writer: writer.name, at: new Date().toISOString() }
      // Only the summary changes, so edits made elsewhere while the model worked are untouched.
      const written = await editSession(pageId, (doc) => {
        const now = { summary: docSummary(doc).toJSON(), fingerprint: docMeta(doc).get(GENERATED_SUMMARY_KEY) }
        if (!mayWriteSummary(trigger, now, before.summary)) return false
        doc.transact(() => {
          editDoc(doc, { summary }, ORIGIN_NOTES)
          docMeta(doc).set(GENERATED_SUMMARY_KEY, summaryFingerprint(summary))
          docMeta(doc).set(NOTES_RUN_KEY, run)
        }, ORIGIN_NOTES)
        return true
      })
      log('notes', written ? 'generated' : 'kept the summary edited during the run', {
        pageId,
        trigger,
        writer: writer.name,
        sections: notes.sections.length,
        ms: Date.now() - started
      })
      if (written || trigger === 'auto') broadcast(pageId, 'done', 1, undefined, trigger === 'manual')
      else broadcast(pageId, 'error', 0, SUMMARY_KEPT)
      return written
    } catch (error) {
      // A newer request took over; it reports its own status.
      if (job.signal.reason instanceof SupersededError) {
        log('notes', 'replaced by a newer request', { pageId, writer: writer?.name ?? null })
        return false
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

  async function backfillStatus(): Promise<NotesBackfill> {
    const found = await survey()
    return {
      outdated: found.outdated.length,
      missing: found.missing.length,
      edited: found.edited.length,
      running: backfilling !== null
    }
  }

  async function backfill(kind: NotesBackfillKind): Promise<NotesBackfillResult> {
    if (backfilling) throw new Error('Summaries are already being written')
    const run: { stop: AbortController; pageId: string | null } = { stop: new AbortController(), pageId: null }
    backfilling = run
    // A function, not the field: TypeScript would keep the value it narrowed before an await.
    const stopped = (): boolean => run.stop.signal.aborted
    const result: NotesBackfillResult = { written: 0, failed: 0, stopped: false }
    const words = BACKFILL_WORDS[kind]
    const base = { id: BACKFILL_ACTIVITY, kind: 'backfill' as const, origin: 'settings' as const }
    try {
      if (!(await deps.writer())) throw new Error('Summaries are turned off in Settings → Summaries')
      const ids = (await survey())[kind]
      const titles = new Map((await listSessions()).map((page) => [page.id, page.title]))
      const failed: string[] = []
      log('notes', 'backfill started', { kind, sessions: ids.length })
      for (const [index, pageId] of ids.entries()) {
        if (stopped()) break
        run.pageId = pageId
        reportActivity({
          ...base,
          title: words.running,
          detail: `${String(index + 1)} of ${String(ids.length)} sessions`,
          progress: index / ids.length,
          actions: ['cancel']
        })
        try {
          // `auto`: a summary edited since the survey is kept, as after a recording.
          if (await generateNotes(pageId, 'auto')) result.written++
        } catch {
          // Already logged and shown on the session; a stop isn't a failure.
          if (!stopped()) {
            result.failed++
            failed.push(titles.get(pageId) ?? 'Untitled')
          }
        }
      }
      result.stopped = stopped()
      log('notes', 'backfill finished', { kind, ...result })
      const done = `${words.done} ${String(result.written)} ${result.written === 1 ? 'summary' : 'summaries'}`
      if (!ids.length) clearActivity(BACKFILL_ACTIVITY)
      else if (result.failed) {
        endActivity(
          { ...base, title: `${done}; ${String(result.failed)} couldn't be written`, detail: `Couldn't write: ${failed.join(', ')}` },
          'partial'
        )
      } else endActivity({ ...base, title: result.stopped ? `Stopped. ${done}` : done }, 'done')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      endActivity({ ...base, title: words.failed, detail: message }, 'failed')
      throw error
    } finally {
      backfilling = null
    }
  }

  function stopBackfill(): boolean {
    if (!backfilling) return false
    backfilling.stop.abort()
    if (backfilling.pageId) jobs.cancel(backfilling.pageId, new Error(SUMMARY_STOPPED))
    return true
  }

  return {
    generateNotes: async (pageId, trigger) => {
      await generateNotes(pageId, trigger)
    },
    summaryEdited: edited,
    backfillStatus,
    backfill,
    stopBackfill,
    cancel: (pageId) => jobs.cancel(pageId, new Error(SUMMARY_STOPPED)),
    register() {
      onActivityAction('notes', (item, action) => {
        if (!item.pageId) return
        if (action === 'cancel') jobs.cancel(item.pageId, new Error(SUMMARY_STOPPED))
        if (action === 'retry') {
          generateNotes(item.pageId, 'manual').catch(() => {
            // Reported through meeting:status, Activity and the log.
          })
        }
      })
      onActivityAction('backfill', (_item, action) => {
        if (action === 'cancel') stopBackfill()
      })
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
      ipcMain.handle('notes:state', (_event, pageId: unknown) => stateOf(z.string().parse(pageId)))
      ipcMain.handle('notes:backfillStatus', () => backfillStatus())
      ipcMain.handle('notes:backfill', (_event, kind: unknown) => backfill(z.enum(['outdated', 'missing']).parse(kind)))
      ipcMain.handle('notes:stopBackfill', () => stopBackfill())
      ipcMain.handle('notes:cancel', (_event, pageId: unknown) => jobs.cancel(z.string().parse(pageId), new Error(SUMMARY_STOPPED)))
    }
  }
}

import { BrowserWindow, ipcMain } from 'electron'
import type { MeetingStatus } from '../../shared/types'
import { log } from '../log'
import { getPage, notifyPagesChanged, savePage } from '../pages'
import { getClaudeKey, hasClaudeKey, setClaudeKey } from '../secrets'
import { getSettings } from '../settings'
import { claudeNotes } from './notesClaude'
import { renderNotes, splitNotes, withNotes } from './notesFormat'
import { localNotes } from './notesLocal'
import { onMeetingLabeled } from './pipeline'

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

/** Writes (or rewrites) the notes section at the top of a meeting note. */
export async function generateNotes(pageId: string): Promise<void> {
  const engine = getSettings().notesEngine
  if (engine === 'off') throw new Error('Meeting notes are turned off in Settings')
  const status = (state: MeetingStatus['state'], progress: number, message?: string): void => {
    broadcast({ pageId, state, progress, ...(message ? { message } : {}) })
  }

  try {
    const { transcript } = splitNotes((await getPage(pageId)).body)
    if (!transcript.trim()) throw new Error('This note has no transcript to summarize')
    status('summarizing', 0)
    const started = Date.now()

    let notes
    if (engine === 'claude') {
      const key = await getClaudeKey()
      if (!key) throw new Error('Add a Claude API key in Settings → Meeting notes')
      notes = await claudeNotes(key, transcript)
    } else {
      notes = await localNotes(transcript, (received, total) => {
        status('downloading', total ? received / total : 0, 'notes model')
      })
      status('summarizing', 0.5)
    }

    // Re-read: the note may have been edited while the model was working.
    const page = await getPage(pageId)
    await savePage({ id: pageId, title: page.title, body: withNotes(page.body, renderNotes(notes)) })
    notifyPagesChanged()
    log('notes', 'generated', { pageId, engine, ms: Date.now() - started })
    status('done', 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('notes', 'failed', { pageId, engine, error: message })
    status('error', 0, message)
    throw error
  }
}

/** Generates notes automatically after a meeting is labeled, when an engine is chosen. */
export function registerMeetingNotes(): void {
  onMeetingLabeled((pageId) => {
    if (getSettings().notesEngine === 'off') return
    generateNotes(pageId).catch(() => {
      // Already reported through meeting:status and the log.
    })
  })
  ipcMain.handle('notes:generate', (_event, pageId: unknown) => {
    if (typeof pageId !== 'string') throw new Error('Invalid page id')
    return generateNotes(pageId)
  })
  ipcMain.handle('secrets:hasClaudeKey', () => hasClaudeKey())
  ipcMain.handle('secrets:setClaudeKey', (_event, key: unknown) => {
    if (key !== null && typeof key !== 'string') throw new Error('Invalid key')
    return setClaudeKey(key)
  })
}

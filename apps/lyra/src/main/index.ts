import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell
} from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { migrateLegacyPages, moveNotes, notesDir, resolveInNotes, startWatchingNotes } from './pages'
import {
  applySessionUpdate,
  closeSessionFor,
  createSession as createPage,
  deleteSession as deletePage,
  flushAllSessions,
  getSessionPage as getPage,
  listSessions as listPages,
  editSession,
  openSessionFor,
  readSession,
  readSessionFromDisk,
  sessionAudioDir,
  sessionRawDir,
  updateManifest,
  saveSessionPage as savePage,
  sidecarPath
} from './sessionStore'
import * as Y from 'yjs'
import {
  ORIGIN_TRANSCRIBER,
  startTranscriber,
  transcriberWrite,
  editDoc,
  ORIGIN_USER,
  readSegment,
  removeLiveNotes,
  replaceTranscript,
  addTag,
  setSegmentText,
  snapshotOf,
  upsertSpeaker
} from '../shared/sessionDoc'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { registerMicPrompt, stopMicPrompt } from './micprompt'
import { parseConsentStore } from './micwatch'
import { registerOverlay, watchMainWindow } from './overlay'
import {
  getMainWindow,
  registerSessionIpc,
  setMainWindow,
  showMainWindow
} from './session'
import { getSettings, onSettingsChanged, overrideSettings, updateSettings } from './settings'
import { assignSpeaker, processMeeting, registerMeetingPipeline } from './meeting/pipeline'
import { addPerson, listPeople } from './voices'
import { generateNotes, registerMeetingNotes } from './meeting/notes'
import { stopNotesWorker } from './meeting/notesLocal'
import { stopSpeakerWorker } from './meeting/speakers'
import { registerRecorderIpc, trackPath } from './recorder'
import { startAudioRetention, sweepAudio } from './audioRetention'
import { createTray } from './tray'
import { registerUpdater } from './updater'
import { broadcastStatus, pcmFromIpc, transcribePcm, warmUp } from './whisper'
import { log, logPath } from './log'
import type { Page, Settings } from '../shared/types'

const isTestRun =
  process.env.VOICE_PAGES_SMOKE === '1' ||
  process.env.VOICE_PAGES_SCREENSHOT === '1' ||
  !!process.env.LYRA_MEETING_FIXTURE

if (isTestRun) {
  app.setPath('userData', join(tmpdir(), `voice-pages-smoke-${process.pid}`))
  overrideSettings({ notesDir: join(app.getPath('userData'), 'notes') })
  if (process.env.VOICE_PAGES_SMOKE === '1') {
    // A pre-0.2 page in the old location, for the migration check.
    const legacy = join(app.getPath('userData'), 'pages')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'legacy-smoke.md'),
      '---\nid: legacy-smoke\ntitle: "Legacy page"\nupdatedAt: 2025-01-01T00:00:00.000Z\n---\n\nold body'
    )
  }
}

/** Set once the user really quits, so closing the window can mean "hide" until then. */
let quitting = false

// One Lyra at a time: a second launch focuses the first instead.
if (!isTestRun && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

function applyLoginItem(openAtLogin: boolean): void {
  if (isTestRun || !app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin })
}

function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
}

function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function createWindow(): void {
  const icon = appIcon()
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Lyra',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161b' : '#ffffff',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep audio capture and transcription running while the window is hidden.
      backgroundThrottling: false
    }
  })
  setMainWindow(mainWindow)
  watchMainWindow(mainWindow)

  // Closing the window hides it; Lyra keeps running in the tray for the global hotkey.
  mainWindow.on('close', (event) => {
    if (quitting || isTestRun) return
    event.preventDefault()
    mainWindow.hide()
  })

  if (process.env.VOICE_PAGES_SMOKE !== '1') {
    mainWindow.on('ready-to-show', () => {
      mainWindow.show()
    })
  }

  // Only hand web links to the OS; file:, smb:, custom-protocol URLs etc. can launch local code.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isWebUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // The renderer is a single local page; never let it navigate to anything else.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.VOICE_PAGES_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      void runUiSmoke(mainWindow)
    })
  }

  const meetingFixture = process.env.LYRA_MEETING_FIXTURE
  if (meetingFixture) {
    mainWindow.webContents.once('did-finish-load', () => {
      void runMeetingFixture(meetingFixture)
    })
  }

  if (process.env.VOICE_PAGES_SCREENSHOT === '1') {
    mainWindow.setContentSize(1280, 800)
    mainWindow.webContents.once('did-finish-load', () => {
      void captureScreenshot(mainWindow)
    })
  }
}

function registerIpc(): void {
  ipcMain.handle('pages:list', () => listPages())
  ipcMain.handle('pages:get', (_event, id: string) => getPage(id))
  ipcMain.handle('pages:create', (_event, options: unknown) =>
    createPage(options && typeof options === 'object' ? options : {})
  )
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_event, patch: Partial<Settings>) => updateSettings(patch))
  ipcMain.handle('settings:pickFolder', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose notes folder',
      defaultPath: notesDir(),
      properties: ['openDirectory', 'createDirectory']
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('notes:move', (_event, fromDir: unknown) => {
    if (typeof fromDir !== 'string') throw new Error('Invalid folder')
    return moveNotes(fromDir)
  })
  ipcMain.handle('notes:reveal', async () => {
    const error = await shell.openPath(notesDir())
    if (error) throw new Error(error)
  })
  ipcMain.handle('pages:save', (_event, page: Pick<Page, 'id' | 'title' | 'body'>) =>
    savePage(page)
  )
  ipcMain.handle('pages:delete', (_event, id: string) => deletePage(id))
  ipcMain.handle('pages:reveal', (_event, id: unknown) => {
    shell.showItemInFolder(resolveInNotes(id))
  })
  ipcMain.handle('sessions:open', (event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid session id')
    return openSessionFor(id, event.sender.id)
  })
  ipcMain.handle('sessions:update', (event, id: unknown, update: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid session id')
    return applySessionUpdate(id, update, event.sender.id)
  })
  ipcMain.on('sessions:close', (event, id: unknown) => {
    if (typeof id === 'string') closeSessionFor(id, event.sender.id)
  })
  ipcMain.on('log:write', (_event, scope: unknown, message: unknown, data: unknown) => {
    log(String(scope), String(message), data)
  })
  ipcMain.handle('whisper:warmUp', () => warmUp())
  ipcMain.handle('whisper:transcribe', (_event, payload: unknown, prompt: unknown) =>
    transcribePcm(pcmFromIpc(payload), typeof prompt === 'string' ? prompt : '')
  )
}

/** A labeled meeting, as the speaker pipeline would leave it, for reviewing the transcript UI. */
async function seedScreenshotMeeting(): Promise<void> {
  const meeting = await createPage({ startedAt: '2026-11-23T10:30:00' })
  const sam = await addPerson('Sam', [0.1, 0.2, 0.3], false)
  const alex = await addPerson('Alex', [0.3, 0.2, 0.1], false)
  await editSession(meeting.id, (doc) => {
    doc.transact(() => {
      addTag(doc, 'design', 'seed')
      addTag(doc, 'team', 'seed')
      editDoc(doc, {
        title: 'Design review',
        summary:
          'Summary\nAgreed to ship the dock redesign first, then settings.\n\nAction items\n- [ ] Dana: port tokens into styles.css\n- [ ] Sam: check contrast in dark mode'
      }, 'seed')
      upsertSpeaker(doc, 'c0', { name: 'Dana', personId: null, confirmed: true, confidence: 0.96, matches: [] }, 'seed')
      upsertSpeaker(doc, 'c1', {
        name: 'Sam',
        personId: sam.id,
        confirmed: false,
        confidence: 0.71,
        matches: [{ personId: sam.id, score: 0.71 }, { personId: alex.id, score: 0.38 }]
      }, 'seed')
      upsertSpeaker(doc, 'c2', { name: 'Speaker 3', personId: null, confirmed: false, confidence: null, matches: [] }, 'seed')
      replaceTranscript(doc, [
        { id: 's0', rawId: 's0', start: 2, end: 7, cluster: 'c0', confidence: 0.97, text: 'I think the dock is the thing people see first, so let’s start there.' },
        { id: 's1', rawId: 's1', start: 9, end: 14, cluster: 'c1', confidence: 0.81, text: 'Agreed. I can check the contrast numbers in dark mode this afternoon.' },
        { id: 's2', rawId: 's2', start: 15, end: 21, cluster: 'c2', confidence: null, text: 'Does the meeting button need its own shortcut in the dock, or is the hotkey enough?' },
        { id: 's3', rawId: 's3', start: 22, end: 27, cluster: 'c0', confidence: 0.95, text: 'Show the shortcut on hover. One primary action, one secondary.' },
        { id: 's4', rawId: 's4', start: 31, end: 38, cluster: 'c1', confidence: 0.52, text: 'From the support side, people mostly ask where their recordings went.' },
        { id: 's5', rawId: 's5', start: 40, end: 45, cluster: 'c1', confidence: 0.78, text: 'Then the folder chip on first run should help with that.' }
      ], 'seed')
    }, 'seed')
  })
}

async function seedScreenshotPages(): Promise<void> {
  if (process.env.LYRA_SCREENSHOT_DIR) await seedScreenshotMeeting()
  const team = await createPage()
  await savePage({
    id: team.id,
    title: 'Team sync notes',
    body:
      'Quick recap from this morning.\n\n' +
      'Keep the first-run flow simple — one page, one record button. ' +
      'Ship sidebar delete before we rename the app in the UI.'
  })

  const journal = await createPage()
  await savePage({
    id: journal.id,
    title: 'Morning journal',
    body:
      'Woke up thinking about how nice it is to talk ideas out without sending audio anywhere. ' +
      'Maybe the default view should always open the latest page.'
  })

  const ideas = await createPage()
  await savePage({
    id: ideas.id,
    title: 'Product ideas',
    body:
      'Lyra should feel like a notebook, not a chatbot.\n\n' +
      'A few things worth trying next:\n' +
      '— Rename pages inline from the sidebar\n' +
      '— Keyboard shortcut for record / stop\n' +
      '— Export a page as plain text or markdown\n\n' +
      'The core loop is already good: open a page, talk, edit, copy, come back later.'
  })
}

async function captureScreenshot(win: BrowserWindow): Promise<void> {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))
  const reload = async (): Promise<void> => {
    const reloaded = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
    })
    win.webContents.reload()
    await reloaded
    await settle()
  }
  const save = async (dir: string, name: string): Promise<void> => {
    const image = await win.webContents.capturePage()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), image.toPNG())
    process.stdout.write(`screenshot: ${join(dir, name)}\n`)
  }
  const pressShortcut = (key: string): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, metaKey: true }))`
    )
  const click = (selector: string): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`
    )

  try {
    // LYRA_SCREENSHOT_DIR captures every state in both themes for UI review; without it,
    // only the README shot is written.
    const reviewDir = process.env.LYRA_SCREENSHOT_DIR
    if (reviewDir) {
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await save(reviewDir, `empty-${theme}.png`)
      }
    }
    await seedScreenshotPages()
    nativeTheme.themeSource = 'light'
    await reload()
    // out/main → the repository's docs/ folder, which the README links to.
    await save(join(__dirname, '../../../../docs'), 'screenshot.png')
    if (reviewDir) {
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await save(reviewDir, `page-${theme}.png`)
        await pressShortcut(',')
        await settle()
        await save(reviewDir, `settings-${theme}.png`)
        // The tabs after General, in nav order.
        for (const [index, tab] of ['recording', 'meetings', 'people'].entries()) {
          await click(`.settings-nav button:nth-of-type(${String(index + 2)})`)
          await settle()
          await save(reviewDir, `settings-${tab}-${theme}.png`)
        }
      }
      // The labeled meeting: transcript, then the speaker picker on a guessed speaker.
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await click('.page-row:last-child .page-item')
        await settle()
        await win.webContents.executeJavaScript(`document.querySelector('.transcript')?.scrollIntoView()`)
        await settle()
        await save(reviewDir, `meeting-${theme}.png`)
        await click('.speaker-chip.likely')
        await settle()
        await save(reviewDir, `picker-${theme}.png`)
        // The same session in the side-panel layout.
        await pressShortcut('.')
        await settle()
        await save(reviewDir, `panel-${theme}.png`)
        await pressShortcut('.')
        await settle()
      }
      // What the session records, and an open themed select.
      nativeTheme.themeSource = 'light'
      await reload()
      await click('.dock-sources')
      await settle()
      await save(reviewDir, 'sources-light.png')
      await click('.picker.sources .select')
      await settle()
      await save(reviewDir, 'select-light.png')
      // Deleting shows the Undo toast; the page comes back on reload since the file stays.
      nativeTheme.themeSource = 'light'
      await reload()
      await click('.page-row:last-child .page-delete')
      await settle()
      await save(reviewDir, 'undo-delete-light.png')
    }
    app.exit(0)
  } catch (error) {
    console.error('screenshot failed', error)
    app.exit(1)
  }
}

/** Checks the Windows mic-usage parser against a captured `reg query` sample. */
function checkConsentParser(): void {
  const root =
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
  const sample = [
    `${root}\\MSTeams_8wekyb3d8bbwe`,
    '    LastUsedTimeStop    REG_QWORD    0x0',
    `${root}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x0',
    `${root}\\NonPackaged\\C:#Apps#Discord.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x1dd78ae61213e7e',
    `${root}\\NonPackaged\\C:#Apps#Lyra#Lyra.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x0'
  ].join('\r\n')
  const users = [...parseConsentStore(sample, 'C:\\Apps\\Lyra\\Lyra.exe')].sort()
  if (users.join(',') !== 'MSTeams,Zoom') {
    throw new Error(`consent parser returned ${users.join(',')}`)
  }
}

/**
 * Dev check: runs the real speaker pipeline (models, diarization, Whisper) on a
 * 16 kHz mono WAV and prints the labeled note. `pnpm smoke:meeting <file.wav>`
 */
async function runMeetingFixture(wavPath: string): Promise<void> {
  try {
    const page = await createPage()
    const micPath = trackPath(page.id, 'mic')
    await mkdir(join(micPath, '..'), { recursive: true })
    await copyFile(wavPath, micPath)
    // Optional second track, to exercise the mic-vs-system "Me" labeling.
    const systemFixture = process.env.LYRA_MEETING_SYSTEM_FIXTURE
    const systemPath = systemFixture ? trackPath(page.id, 'system') : null
    if (systemFixture && systemPath) await copyFile(systemFixture, systemPath)
    const started = Date.now()
    await processMeeting({ pageId: page.id, micPath, systemPath, seconds: 0 })
    await flushAllSessions()
    const exported = await readFile(join(notesDir(), page.id), 'utf8')
    const took = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(`meeting-fixture (${took} s):\n${exported}\n`)
    const labeled = await readSession(page.id)
    const confidence = labeled.transcript.map((segment) =>
      segment.confidence === null ? '-' : segment.confidence.toFixed(2)
    )
    process.stdout.write(`meeting-fixture line confidence: ${confidence.join(' ')}\n`)
    // Evals (scripts/run-eval.cjs) score this pass, before the rename below changes any labels.
    const output = process.env.LYRA_MEETING_OUTPUT
    if (output) {
      const segments = labeled.transcript.map(({ start, end, cluster, text }) => ({
        speaker: cluster ?? 'unknown',
        start,
        end,
        text
      }))
      await writeFile(output, JSON.stringify({ seconds: +took, segments }, null, 2), 'utf8')
    }

    // Name the first speaker and save their voice, as the speaker picker does.
    const first = labeled.speakers[0]
    if (!first) {
      // One voice: the session stays notes, so there's nothing to name.
      process.stdout.write('meeting-fixture: one voice, kept as notes\n')
      app.exit(0)
      return
    }
    await assignSpeaker(page.id, first.id, { name: 'Fixture Person', remember: true })
    await flushAllSessions()
    const renamed = await readFile(join(notesDir(), page.id), 'utf8')
    const people = await listPeople()
    if (!renamed.includes('] Fixture Person: ') || people.length !== 1) {
      throw new Error('naming did not update the export or save the voice')
    }
    process.stdout.write('meeting-fixture: relabel ok\n')

    // Optional: LYRA_NOTES_ENGINE=local|claude also writes meeting notes.
    const engine = process.env.LYRA_NOTES_ENGINE
    if (engine === 'local' || engine === 'claude') {
      overrideSettings({ notesEngine: engine })
      const notesStarted = Date.now()
      await generateNotes(page.id)
      const withNotes = await readSession(page.id)
      const notesTook = ((Date.now() - notesStarted) / 1000).toFixed(1)
      process.stdout.write(`meeting-fixture notes (${engine}, ${notesTook} s):\n${withNotes.summary}\n`)
    }
    app.exit(0)
  } catch (error) {
    console.error('meeting-fixture failed', error)
    app.exit(1)
  }
}

/** Session store: concurrent edits merge, the log persists, and the export follows. */
async function checkSessionStore(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`session store: ${message}`)
  }
  const page = await createPage({ startedAt: '2026-02-03T04:05:06' })
  const state = await openSessionFor(page.id, -1)

  // Two windows edit the same starting state; both edits must survive.
  const replicas = [new Y.Doc(), new Y.Doc()]
  for (const replica of replicas) Y.applyUpdate(replica, state)
  const send = async (replica: Y.Doc, change: () => void): Promise<void> => {
    const updates: Uint8Array[] = []
    const collect = (update: Uint8Array): void => {
      updates.push(update)
    }
    replica.on('update', collect)
    change()
    replica.off('update', collect)
    for (const update of updates) await applySessionUpdate(page.id, update, -1)
  }
  const [a, b] = replicas
  if (!a || !b) return fail('replicas')
  await send(a, () => {
    editDoc(a, { title: 'Merged', notes: 'first' }, ORIGIN_USER)
  })
  await send(b, () => {
    editDoc(b, { notes: 'second' }, ORIGIN_USER)
  })
  const merged = await getPage(page.id)
  if (merged.title !== 'Merged' || !merged.body.includes('first') || !merged.body.includes('second')) {
    fail(`concurrent edits did not merge: ${JSON.stringify(merged)}`)
  }
  closeSessionFor(page.id, -1)

  // The log on disk rebuilds the same document.
  const fromDisk = await readSessionFromDisk(page.id)
  if (fromDisk.notes !== merged.body || fromDisk.title !== 'Merged') fail('log did not persist')

  // The export and its metadata follow the document.
  await flushAllSessions()
  const exported = await readFile(join(notesDir(), page.id), 'utf8')
  if (!exported.startsWith('Merged\n\n') || !exported.endsWith(merged.body)) {
    fail(`export is wrong: ${JSON.stringify(exported)}`)
  }
  const sidecar: unknown = JSON.parse(await readFile(sidecarPath(page.id), 'utf8'))
  const meta = sidecar as { schema?: unknown; title?: unknown; editable?: unknown; export?: unknown }
  if (meta.schema !== 'lyra.session/1' || meta.title !== 'Merged' || meta.editable !== false || meta.export !== page.id) {
    fail(`metadata is wrong: ${JSON.stringify(sidecar)}`)
  }

  // An outside edit to the export is kept as a copy before Lyra overwrites it.
  await writeFile(join(notesDir(), page.id), 'edited by another tool', 'utf8')
  await savePage({ id: page.id, title: 'Merged', body: `${merged.body} again` })
  const backups = await readdir(join(notesDir(), '.sessions', page.id, 'external')).catch(() => [])
  if (backups.length !== 1) fail(`outside edit was not backed up (${String(backups.length)})`)

  // A note dropped into the folder becomes a session without its file changing.
  const dropped = 'Dropped note\n\nwritten elsewhere\r\nwith CRLF'
  await writeFile(join(notesDir(), 'dropped-smoke.txt'), dropped, 'utf8')
  const list = await listPages()
  if (list.find((entry) => entry.id === 'dropped-smoke.txt')?.title !== 'Dropped note') {
    fail('dropped note was not listed')
  }
  if ((await readFile(join(notesDir(), 'dropped-smoke.txt'), 'utf8')) !== dropped) {
    fail('migration rewrote the note file')
  }

  for (const id of [page.id, 'dropped-smoke.txt']) {
    await deletePage(id)
    if (existsSync(join(notesDir(), id)) || existsSync(join(notesDir(), '.sessions', id))) {
      fail(`delete left files behind for ${id}`)
    }
  }
}

/** Retention deletes only audio older than the setting, and nothing when set to forever. */
async function checkAudioRetention(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`retention: ${message}`)
  }
  const make = async (endedDaysAgo: number): Promise<string> => {
    const page = await createPage()
    await mkdir(sessionAudioDir(page.id), { recursive: true })
    await writeFile(trackPath(page.id, 'mic'), 'x')
    const endedAt = new Date(Date.now() - endedDaysAgo * 86_400_000).toISOString()
    await updateManifest(page.id, (manifest) => ({
      ...manifest,
      endedAt,
      audio: 'kept',
      tracks: [{ name: 'mic', file: 'mic.wav', sampleRate: 16000, seconds: 1 }]
    }))
    return page.id
  }
  const old = await make(40)
  const fresh = await make(1)
  // Lyra 0.2 kept audio beside the notes; an old file there goes too.
  const legacyDir = join(notesDir(), '.audio')
  await mkdir(legacyDir, { recursive: true })
  const legacy = join(legacyDir, 'retention-legacy.mic.wav')
  await writeFile(legacy, 'x')
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000)
  await utimes(legacy, fortyDaysAgo, fortyDaysAgo)

  overrideSettings({ audioRetentionDays: null })
  if ((await sweepAudio()) !== 0 || !existsSync(trackPath(old, 'mic'))) fail('forever deleted audio')
  overrideSettings({ audioRetentionDays: 30 })
  const deleted = await sweepAudio()
  if (deleted !== 2 || existsSync(trackPath(old, 'mic')) || existsSync(legacy) || !existsSync(trackPath(fresh, 'mic'))) {
    fail(`30 days deleted ${String(deleted)}`)
  }
  await flushAllSessions()
  const sidecar = JSON.parse(await readFile(sidecarPath(old), 'utf8')) as { audioStatus?: unknown; audio?: unknown }
  if (sidecar.audioStatus !== 'deleted' || !Array.isArray(sidecar.audio) || sidecar.audio.length) {
    fail(`metadata still lists deleted audio: ${JSON.stringify(sidecar)}`)
  }
  for (const id of [old, fresh]) await deletePage(id)
}

/** Transcript edits survive a new pass, live text accumulates, and old meetings migrate. */
async function checkTranscriptModel(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`transcript: ${message}`)
  }
  const doc = new Y.Doc()
  // The transcriber writes at its own cursor while the user types around it, and the user's
  // undo never takes transcribed words back.
  const notesText = (): string => snapshotOf(doc).notes
  editDoc(doc, { notes: 'Agenda' }, ORIGIN_USER)
  const undo = new Y.UndoManager(doc.getText('notes'), { trackedOrigins: new Set([ORIGIN_USER]) })
  startTranscriber(doc, ORIGIN_TRANSCRIBER)
  transcriberWrite(doc, '\n\nHello', ORIGIN_TRANSCRIBER)
  editDoc(doc, { notes: `My ${notesText()}` }, ORIGIN_USER)
  undo.stopCapturing()
  editDoc(doc, { notes: `${notesText()} typed` }, ORIGIN_USER)
  transcriberWrite(doc, ' there.', ORIGIN_TRANSCRIBER)
  if (notesText() !== 'My Agenda\n\nHello there. typed') fail(`transcriber cursor: ${JSON.stringify(notesText())}`)
  undo.undo()
  if (notesText() !== 'My Agenda\n\nHello there.') fail(`undo took transcribed text: ${JSON.stringify(notesText())}`)
  undo.destroy()
  // Once labeled, untouched transcribed text comes back out; edited text stays.
  removeLiveNotes(doc, 'pipeline')
  if (notesText() !== 'My Agenda') fail(`live notes: ${JSON.stringify(notesText())}`)
  startTranscriber(doc, ORIGIN_TRANSCRIBER)
  transcriberWrite(doc, ' kept', ORIGIN_TRANSCRIBER)
  editDoc(doc, { notes: 'My Agenda KEPT' }, ORIGIN_USER)
  removeLiveNotes(doc, 'pipeline')
  if (notesText() !== 'My Agenda KEPT') fail('edited live text was removed')
  replaceTranscript(doc, [
    { id: 'a', rawId: 'a', start: 0, end: 4, cluster: 'c0', confidence: 0.9, text: 'Hello there.' },
    { id: 'b', rawId: 'b', start: 4, end: 8, cluster: 'c1', confidence: 0.4, text: 'Hi.' }
  ], 'pipeline')
  setSegmentText(doc, 'b', 'Hi, all.', ORIGIN_USER)
  replaceTranscript(doc, [
    { id: 'a2', rawId: 'a2', start: 0, end: 4.2, cluster: 'c0', confidence: 0.9, text: 'Hello there.' },
    { id: 'b2', rawId: 'b2', start: 4.1, end: 8, cluster: 'c1', confidence: 0.5, text: 'Hi' }
  ], 'pipeline')
  const kept = snapshotOf(doc).transcript.find((segment) => segment.id === 'b2')
  if (kept?.text !== 'Hi, all.' || !kept.edited || kept.original !== 'Hi') {
    fail(`an edit did not survive a new pass: ${JSON.stringify(kept)}`)
  }
  doc.destroy()

  // A Lyra 0.2 meeting: labeled lines in the note, speakers in .meta, audio in .audio.
  const id = 'legacy-meeting-smoke.txt'
  await mkdir(join(notesDir(), '.meta'), { recursive: true })
  await mkdir(join(notesDir(), '.audio'), { recursive: true })
  await writeFile(join(notesDir(), '.meta', 'legacy-meeting-smoke.json'), JSON.stringify({
    version: 1,
    speakers: [
      { cluster: 0, name: 'Ana', personId: null, embedding: [0.1, 0.2] },
      { cluster: 1, name: 'Ben', personId: null, embedding: [0.3, 0.4] }
    ],
    liveTranscript: 'rough live text'
  }))
  await writeFile(join(notesDir(), '.audio', 'legacy-meeting-smoke.mic.wav'), Buffer.alloc(44 + 32000))
  await writeFile(join(notesDir(), id), [
    'Weekly sync', '', 'Summary', 'We planned.', '', '──── Transcript ────', '',
    'People: Ana, Ben', '', '[00:00:00] Ana: Morning.', '', '[00:00:04] Ben: Hi Ana.'
  ].join('\n'))
  const listed = await listPages()
  if (!listed.some((entry) => entry.id === id)) fail('legacy meeting not listed')
  const migrated = await readSession(id)
  const lines = migrated.transcript.map((segment) => `${segment.cluster ?? '?'}:${segment.text}`)
  if (lines.join('|') !== 'c0:Morning.|c1:Hi Ana.' || !migrated.summary.includes('We planned.')) {
    fail(`legacy meeting migrated wrong: ${JSON.stringify(migrated)}`)
  }
  if (!existsSync(trackPath(id, 'mic')) || existsSync(join(notesDir(), '.audio', 'legacy-meeting-smoke.mic.wav'))) {
    fail('legacy audio was not moved into the session')
  }
  if (!existsSync(join(sessionRawDir(id), 'legacy.json'))) fail('legacy pass was not kept')
  // Editing a line through the document reaches the export.
  await editSession(id, (session) => {
    const segment = session.getArray<Y.Map<unknown>>('transcript').get(1)
    const segmentId = readSegment(segment).id
    setSegmentText(session, segmentId, 'Hi Ana, good morning.', ORIGIN_USER)
  })
  const exported = await readFile(join(notesDir(), id), 'utf8')
  if (!exported.includes('[00:00:04] Ben: Hi Ana, good morning.') || !exported.startsWith('Weekly sync')) {
    fail(`export after a line edit: ${JSON.stringify(exported)}`)
  }
  // Naming a speaker the same as another merges them: one speaker, all their lines.
  // Even when the name also saves a new voice (remember), the same name still merges.
  await assignSpeaker(id, 'c1', { name: 'ana', remember: true })
  const merged = await readSession(id)
  if (merged.speakers.length !== 1 || merged.transcript.some((line) => line.cluster !== 'c0')) {
    fail(`speakers did not merge: ${JSON.stringify(merged.speakers)}`)
  }
  await deletePage(id)
}

async function runUiSmoke(win: BrowserWindow): Promise<void> {
  try {
    checkConsentParser()
    await checkSessionStore()
    await checkAudioRetention()
    await checkTranscriptModel()
    const result: unknown = await win.webContents.executeJavaScript(`
      (async () => {
        const fail = (message) => { throw new Error(message) }
        const list0 = await window.api.listPages()
        const legacy = list0.find((page) => page.id === 'legacy-smoke.md')
        if (!legacy || legacy.title !== 'Legacy page') fail('legacy page was not migrated')

        for (const fileFormat of ['txt', 'md']) {
          await window.api.updateSettings({ fileFormat })
          const created = await window.api.createPage({ startedAt: '2026-01-02T03:04:05' })
          if (!created.id.startsWith('2026-01-02_03-04-05') || !created.id.endsWith('.' + fileFormat)) {
            fail('unexpected file name ' + created.id)
          }
          await window.api.savePage({ id: created.id, title: 'Smoke page', body: 'hello from smoke' })
          const loaded = await window.api.getPage(created.id)
          if (loaded.title !== 'Smoke page' || loaded.body !== 'hello from smoke') {
            fail(fileFormat + ' page did not round-trip: ' + JSON.stringify(loaded))
          }
          const list = await window.api.listPages()
          if (!list.some((page) => page.id === created.id)) fail('page missing from list')

          // Untitled: the body's first line must not turn into the title on reload.
          const twoParagraphs = ['First line', '', 'Second'].join(String.fromCharCode(10))
          await window.api.savePage({ id: created.id, title: 'Untitled', body: twoParagraphs })
          const untitled = await window.api.getPage(created.id)
          if (untitled.title !== 'Untitled' || untitled.body !== twoParagraphs) {
            fail(fileFormat + ' untitled page did not round-trip: ' + JSON.stringify(untitled))
          }
          await window.api.deletePage(created.id)
        }

        const session = await window.api.createPage()
        const state = await window.api.openSession(session.id)
        if (!(state instanceof Uint8Array) || state.byteLength === 0) fail('openSession returned no state')
        const badUpdate = await window.api.updateSession(session.id, 'not an update').then(() => false, () => true)
        if (!badUpdate) fail('updateSession accepted a non-binary update')
        window.api.closeSession(session.id)
        await window.api.deletePage(session.id)

        const meetingPage = await window.api.createPage()
        await window.api.startRecording(meetingPage.id, false)
        window.api.appendRecording('mic', new Int16Array(16000).fill(1000))
        window.api.appendRecordingWords([{ text: ' Hello', start: 0.2, end: 0.6 }])
        const recording = await window.api.stopRecording()
        if (!recording || Math.abs(recording.seconds - 1) > 0.01 || recording.systemPath !== null) {
          fail('recording was wrong: ' + JSON.stringify(recording))
        }
        // Recording again continues the same timeline, with the computer's audio padded in.
        await window.api.startRecording(meetingPage.id, true)
        window.api.appendRecording('mic', new Int16Array(8000).fill(500))
        window.api.appendRecording('system', new Int16Array(8000).fill(500))
        const second = await window.api.stopRecording()
        if (!second || Math.abs(second.seconds - 1.5) > 0.01 || !second.systemPath) {
          fail('continued recording was wrong: ' + JSON.stringify(second))
        }
        const heard = await window.api.sessionAudio(meetingPage.id, 0.5, 1.0)
        if (!(heard instanceof Int16Array) || heard.length !== 8000) fail('session audio length ' + heard.length)
        await window.api.deletePage(meetingPage.id)

        for (const bad of ['../escape.txt', '..\\\\escape.txt', '.hidden.txt', 'x/y.txt', 'note.exe']) {
          const rejected = await window.api.getPage(bad).then(() => false, () => true)
          if (!rejected) fail('path guard let through ' + bad)
          const revealRejected = await window.api.revealPage(bad).then(() => false, () => true)
          if (!revealRejected) fail('reveal let through ' + bad)
        }
        return 'ok'
      })()
    `)
    process.stdout.write(`ui-smoke: ${String(result)}
`)
    app.exit(0)
  } catch (error) {
    console.error('ui-smoke failed', error)
    app.exit(1)
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.voicepages.app')
  log('app', `started ${app.getVersion()}`, { log: logPath() })

  const icon = appIcon()
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    app.dock?.setIcon(icon)
  }

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'clipboard-sanitized-write'
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  // Meetings ask for system audio via getDisplayMedia; answer with the loopback
  // device and the primary screen (its video track is discarded) — no picker.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame?.top !== getMainWindow()?.webContents.mainFrame) {
      callback({})
      return
    }
    desktopCapturer.getSources({ types: ['screen'] }).then(
      ([screen]) => {
        callback(screen ? { video: screen, audio: 'loopback' } : {})
      },
      (error: unknown) => {
        log('capture', 'could not list screens for system audio', String(error))
        callback({})
      }
    )
  })

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  registerSessionIpc()
  registerRecorderIpc()
  registerMeetingPipeline({ processRecordings: !isTestRun })
  registerMeetingNotes()
  registerUpdater()
  if (!isTestRun) {
    createTray()
    registerHotkeys()
    registerOverlay()
    registerMicPrompt()
    applyLoginItem(getSettings().launchAtLogin)
    onSettingsChanged((next, prev) => {
      if (next.launchAtLogin !== prev.launchAtLogin) applyLoginItem(next.launchAtLogin)
    })
  }
  void migrateLegacyPages().finally(() => {
    startWatchingNotes()
    startAudioRetention()
    createWindow()
  })
  broadcastStatus({ state: 'idle' })

  app.on('activate', () => {
    if (getMainWindow()) showMainWindow()
    else createWindow()
  })
})

let flushed = false
app.on('before-quit', (event) => {
  quitting = true
  // Write pending exports and compact session logs before the process goes away.
  if (flushed) return
  event.preventDefault()
  void flushAllSessions().finally(() => {
    flushed = true
    app.quit()
  })
})

app.on('will-quit', () => {
  unregisterHotkeys()
  stopSpeakerWorker()
  stopNotesWorker()
  stopMicPrompt()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

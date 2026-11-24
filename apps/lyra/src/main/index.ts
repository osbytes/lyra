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
import { attachEditMenu } from './editMenu'
import { migrateLegacyPages, moveNotes, notesDir, resolveInNotes, startWatchingNotes } from './pages'
import {
  applySessionUpdate,
  closeSessionFor,
  createSession as createPage,
  deleteSession as deletePage,
  emptySessionTrash,
  restoreSession,
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
  setAutoTitle,
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
  appendLiveSegment,
  liveModeOf,
  livePlaced,
  markPlaced,
  joinSplitLines,
  initDoc,
  mergeSpeakers,
  renumberSpeakers,
  addTag,
  setSegmentEdits,
  setSegmentText,
  snapshotOf,
  docTranscript,
  upsertSpeaker
} from '../shared/sessionDoc'
import {
  correctRange,
  removeRange,
  restoreRange,
  toggleHighlight,
  type TranscriptEdit
} from '../shared/transcriptOverlay'
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
import { registerTitleSuggestions, suggestTitle } from './meeting/title'
import { defaultTitle, partOfDay } from './sessionTitle'
import { stopNotesWorker } from './meeting/notesLocal'
import { stopSpeakerWorker } from './meeting/speakers'
import { replayRecording } from './meeting/replay'
import { relabeled, relabelSession } from './meeting/relabel'
import { identifiesSpeakers, onRecordingFinished, registerRecorderIpc, trackPath } from './recorder'
import { startAudioRetention, sweepAudio } from './audioRetention'
import { createTray } from './tray'
import { registerUpdater } from './updater'
import { broadcastStatus, pcmFromIpc, transcribePcm, warmUp } from './whisper'
import { log, logPath } from './log'
import { searchSessions } from './search'
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
  attachEditMenu(mainWindow)

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
  ipcMain.handle('pages:search', (_event, query: unknown) =>
    typeof query === 'string' ? searchSessions(query.slice(0, 200)) : []
  )
  ipcMain.handle('pages:get', (_event, id: string) => getPage(id))
  ipcMain.handle('pages:create', (_event, options: unknown) =>
    createPage(options && typeof options === 'object' ? options : {})
  )
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_event, patch: Partial<Settings>) => updateSettings(patch))
  ipcMain.handle('settings:pickFolder', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose sessions folder',
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
  ipcMain.handle('pages:delete', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid page id')
    return deletePage(id)
  })
  ipcMain.handle('pages:restore', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid page id')
    return restoreSession(id)
  })
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

/**
 * Review shots of the locked transcript: the selection toolbar, a correction, a removal and a
 * highlight, the right-click menu, the Raw view, and Ctrl+Z taking the edits back one by one.
 */
async function reviewTranscriptEditing(
  win: BrowserWindow,
  theme: 'light' | 'dark',
  dir: string,
  save: (dir: string, name: string) => Promise<void>,
  settle: () => Promise<void>
): Promise<void> {
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  // Selects `words` inside line `id` the way a drag would.
  const select = (id: string, words: string): Promise<unknown> =>
    run(`(() => {
      const piece = [...document.querySelectorAll('[data-line="${id}"] [data-kind="raw"]')]
        .find((el) => el.textContent.includes(${JSON.stringify(words)}))
      const node = piece?.firstChild
      if (!node) return false
      const start = node.textContent.indexOf(${JSON.stringify(words)})
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + ${String(words.length)})
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    })()`)
  const bar = (label: string): Promise<unknown> =>
    run(`[...document.querySelectorAll('.selection-bar button')].find((b) => b.textContent === ${JSON.stringify(label)})?.click()`)
  const lineText = (id: string): Promise<unknown> =>
    run(`(() => {
      const line = document.querySelector('[data-line="${id}"]')?.cloneNode(true)
      line?.querySelectorAll('del').forEach((el) => el.remove())
      const marks = [...(document.querySelector('[data-line="${id}"]')?.querySelectorAll('ins, del, .hl') ?? [])]
      return line ? line.textContent + ' [' + marks.map((el) => el.tagName === 'SPAN' ? 'hl' : el.tagName.toLowerCase()).join(',') + ']' : null
    })()`)
  const undoKey = (): Promise<unknown> =>
    run(`document.querySelector('.lines').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true }))`)

  if (!(await select('s1', 'contrast numbers'))) throw new Error('could not select words')
  await settle()
  await save(dir, `transcript-select-${theme}.png`)
  await bar('Highlight')
  await settle()
  await select('s1', ' this afternoon')
  await settle()
  await bar('Remove')
  await settle()
  await select('s0', 'dock')
  await settle()
  await bar('Correct')
  await settle()
  await run(`(() => {
    const input = document.querySelector('.correct-pop input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'dark mode')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await save(dir, `transcript-correct-${theme}.png`)
  await run(`document.querySelector('.correct-pop').requestSubmit()`)
  await settle()
  await save(dir, `transcript-edited-${theme}.png`)
  const box = (await run(
    `(() => { const r = document.querySelector('[data-line="s4"]').getBoundingClientRect(); return [r.left + 40, r.top + 8] })()`
  )) as [number, number]
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box[0], y: box[1], button: 'right', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box[0], y: box[1], button: 'right', clickCount: 1 })
  await settle()
  await save(dir, `transcript-menu-${theme}.png`)
  await run(`document.querySelector('.picker-layer')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await run(`document.querySelector('.transcript-mode button:last-child').click()`)
  await settle()
  await save(dir, `transcript-raw-${theme}.png`)
  await run(`document.querySelector('.transcript-mode button:first-child').click()`)
  await settle()
  const steps = [String(await lineText('s0')), String(await lineText('s1'))]
  for (let i = 0; i < 3; i++) {
    await undoKey()
    await settle()
    steps.push(`${String(await lineText('s0'))} / ${String(await lineText('s1'))}`)
  }
  process.stdout.write(`transcript undo (${theme}):\n  ${steps.join('\n  ')}\n`)
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
        await pressShortcut('k')
        await settle()
        await save(reviewDir, `search-recent-${theme}.png`)
        // A typo, to show fuzzy matching reaching the transcript.
        await win.webContents.insertText('contrst')
        await settle()
        await save(reviewDir, `search-${theme}.png`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        await settle()
        await save(reviewDir, `search-open-${theme}.png`)
        await reload()
        await pressShortcut(',')
        await settle()
        await save(reviewDir, `settings-${theme}.png`)
        // The tabs after General, in nav order.
        for (const [index, tab] of ['sessions', 'people'].entries()) {
          await click(`.settings-nav button:nth-of-type(${String(index + 2)})`)
          await settle()
          await save(reviewDir, `settings-${tab}-${theme}.png`)
        }
      }
      // The labeled meeting: transcript, then the speaker picker on a guessed speaker.
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        // By title: editing the meeting moves it to the top of the list.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.page-item')].find((el) => el.textContent.includes('Design review'))?.click()`
        )
        await settle()
        await win.webContents.executeJavaScript(`document.querySelector('.transcript')?.scrollIntoView()`)
        await settle()
        await save(reviewDir, `meeting-${theme}.png`)
        await reviewTranscriptEditing(win, theme, reviewDir, save, settle)
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
      // A session's right-click menu, and a tooltip.
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await win.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('.page-row')
          const box = row?.getBoundingClientRect()
          row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: (box?.left ?? 0) + 60, clientY: (box?.top ?? 0) + 20 }))
        })()`)
        await settle()
        await save(reviewDir, `menu-${theme}.png`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        await settle()
        const point: unknown = await win.webContents.executeJavaScript(`(() => {
          const box = document.querySelector('.sidebar-footer .ghost-btn')?.getBoundingClientRect()
          return box ? [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)] : [0, 0]
        })()`)
        const [x = 0, y = 0] = Array.isArray(point) ? point.map(Number) : []
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await new Promise((resolve) => setTimeout(resolve, 900))
        await save(reviewDir, `tooltip-${theme}.png`)
      }
      // Deleting asks first, then shows the Undo toast; Ctrl+Z brings the session back.
      nativeTheme.themeSource = 'light'
      await reload()
      await click('.page-row:last-child .page-delete')
      await settle()
      await save(reviewDir, 'confirm-delete-light.png')
      await click('.confirm .btn.primary')
      await settle()
      await save(reviewDir, 'undo-delete-light.png')
      await pressShortcut('z')
      await settle()
      await save(reviewDir, 'undid-delete-light.png')
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
    // Optional second track, to exercise the mic-vs-system "Me" labeling.
    const systemFixture = process.env.LYRA_MEETING_SYSTEM_FIXTURE ?? null
    const started = Date.now()
    // `live` (the default) replays the audio as a recording; `offline` labels it after the fact.
    if (process.env.LYRA_MEETING_PIPELINE === 'offline') {
      const micPath = trackPath(page.id, 'mic')
      await mkdir(join(micPath, '..'), { recursive: true })
      await copyFile(wavPath, micPath)
      const systemPath = systemFixture ? trackPath(page.id, 'system') : null
      if (systemFixture && systemPath) await copyFile(systemFixture, systemPath)
      await processMeeting({ pageId: page.id, micPath, systemPath, seconds: 0 })
    } else {
      await replayRecording(page.id, wavPath, systemFixture)
      await relabeled(page.id)
    }
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
      // The live pass's decisions too, so a bad result can be traced to the phrase that caused it.
      const livePath = join(sessionRawDir(page.id), 'live.json')
      const live: unknown = existsSync(livePath) ? JSON.parse(await readFile(livePath, 'utf8')) : null
      const trace = live && typeof live === 'object' && 'trace' in live ? live.trace : []
      await writeFile(output, JSON.stringify({ seconds: +took, segments, trace }, null, 2), 'utf8')
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
      // The recording ended before the engine was turned on, so ask for the title here.
      const before = withNotes.title
      const titleStarted = Date.now()
      await suggestTitle(page.id)
      const titled = (await readSession(page.id)).title
      const titleTook = ((Date.now() - titleStarted) / 1000).toFixed(1)
      process.stdout.write(`meeting-fixture title (${engine}, ${titleTook} s): "${before}" -> "${titled}"\n`)
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
  // A new session is titled by when it started, and takes suggestions until the user titles it.
  if (page.title !== defaultTitle(new Date('2026-02-03T04:05:06')) || !page.title.startsWith('Tuesday early morning · Feb 3, 4:05')) {
    fail(`default title is wrong: ${page.title}`)
  }
  const parts = ['00:10', '02:00', '05:30', '09:00', '11:30', '12:10', '15:00', '18:00', '21:00', '23:50']
    .map((time) => partOfDay(new Date(`2026-02-03T${time}:00`)))
  if (parts.join('|') !== 'midnight|late night|early morning|morning|mid-day|noon|afternoon|evening|night|midnight') {
    fail(`parts of the day are wrong: ${parts.join('|')}`)
  }
  if (!(await setAutoTitle(page.id, 'Suggested')) || (await getPage(page.id)).title !== 'Suggested') {
    fail('an untouched title did not take a suggestion')
  }
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
  if (await setAutoTitle(page.id, 'Overwritten')) fail('a suggestion replaced the user’s title')
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
  // The kept line keeps the raw words its edits were made over, so the overlay still lines up.
  if (kept?.text !== 'Hi, all.' || !kept.edited || kept.original !== 'Hi.') {
    fail(`an edit did not survive a new pass: ${JSON.stringify(kept)}`)
  }

  // The transcript is locked: edits overlay the raw line, which never changes, and each
  // action undoes on its own.
  replaceTranscript(doc, [
    { id: 'o', rawId: 'o', start: 10, end: 14, cluster: 'c0', confidence: 0.9, text: 'So um the cat sat on teh mat.' }
  ], 'pipeline')
  const heard = 'So um the cat sat on teh mat.'
  const lineEdits = (): TranscriptEdit[] =>
    snapshotOf(doc).transcript.find((segment) => segment.id === 'o')?.edits ?? []
  const overlayUndo = new Y.UndoManager(docTranscript(doc), { trackedOrigins: new Set([ORIGIN_USER]), captureTimeout: 60_000 })
  const at = (word: string): { start: number; end: number } => {
    const start = heard.indexOf(word)
    return { start, end: start + word.length }
  }
  const act = (edits: TranscriptEdit[]): void => {
    overlayUndo.stopCapturing()
    setSegmentEdits(doc, 'o', edits, ORIGIN_USER)
    overlayUndo.stopCapturing()
  }
  act(removeRange(lineEdits(), at('um')))
  act(correctRange(heard, lineEdits(), at('teh'), 'the'))
  act(toggleHighlight(lineEdits(), at('cat sat')))
  const overlaid = snapshotOf(doc).transcript.find((segment) => segment.id === 'o')
  if (overlaid?.text !== 'So the cat sat on the mat.' || overlaid.original !== heard || !overlaid.edited) {
    fail(`overlay: ${JSON.stringify(overlaid)}`)
  }
  if (lineEdits().length !== 3) fail(`overlay edits: ${JSON.stringify(lineEdits())}`)
  overlayUndo.undo()
  overlayUndo.undo()
  const undone = snapshotOf(doc).transcript.find((segment) => segment.id === 'o')
  if (undone?.text !== 'So the cat sat on teh mat.' || undone.edits.length !== 1) {
    fail(`overlay undo should go one action at a time: ${JSON.stringify(undone)}`)
  }
  act(restoreRange(lineEdits(), { start: 0, end: heard.length }))
  if (snapshotOf(doc).transcript.find((segment) => segment.id === 'o')?.text !== heard) {
    fail('restoring a line should bring back what was heard')
  }
  overlayUndo.destroy()
  doc.destroy()

  // Live speakers: phrases become lines for their speaker, one line per turn, and each placed
  // phrase is counted so the window knows which unconfirmed words it still has to draw.
  const live = new Y.Doc()
  initDoc(live, { title: 'Live', notes: '' }, ORIGIN_USER)
  startTranscriber(live, ORIGIN_TRANSCRIBER, 'transcript')
  if (liveModeOf(live) !== 'transcript') fail('a new take should write the transcript')
  markPlaced(live, ORIGIN_TRANSCRIBER)
  if (livePlaced(live) !== 1) fail('placed phrases are not counted')
  const gaps = { joinGap: 2, maxLine: 30 }
  appendLiveSegment(live, { id: 'l1', rawId: null, start: 0, end: 1, cluster: 'c0', confidence: 0.9, text: 'morning all' }, gaps, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l2', rawId: null, start: 1.5, end: 3, cluster: 'c0', confidence: 0.7, text: 'shall we start?' }, gaps, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l3', rawId: null, start: 3.5, end: 5, cluster: 'c1', confidence: null, text: 'yes' }, gaps, ORIGIN_TRANSCRIBER)
  const liveLines = snapshotOf(live).transcript.map((line) => `${line.cluster ?? '?'}:${line.text}:${String(line.confidence)}`)
  if (liveLines.join('|') !== 'c0:Morning all shall we start?:0.7|c1:Yes:null') {
    fail(`live lines: ${JSON.stringify(liveLines)}`)
  }
  // A phantom voice merged back: its split lines rejoin and placeholder names close the gap.
  upsertSpeaker(live, 'c0', { name: 'Speaker 1' }, ORIGIN_TRANSCRIBER)
  upsertSpeaker(live, 'c1', { name: 'Speaker 2' }, ORIGIN_TRANSCRIBER)
  upsertSpeaker(live, 'c2', { name: 'Speaker 3' }, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l4', rawId: null, start: 5.5, end: 7, cluster: 'c2', confidence: null, text: 'then the plan' }, gaps, ORIGIN_TRANSCRIBER)
  mergeSpeakers(live, 'c1', 'c0', ORIGIN_TRANSCRIBER)
  joinSplitLines(live, 30, ORIGIN_TRANSCRIBER)
  renumberSpeakers(live, ORIGIN_TRANSCRIBER)
  const rejoined = snapshotOf(live)
  const mergedLines = rejoined.transcript.map((line) => `${line.cluster ?? '?'}:${line.text}`).join('|')
  if (mergedLines !== 'c0:Morning all shall we start? Yes|c2:Then the plan') fail(`rejoined lines: ${mergedLines}`)
  if (rejoined.speakers.find((speaker) => speaker.id === 'c2')?.name !== 'Speaker 2') fail('placeholders not renumbered')
  live.destroy()

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
  // Search reaches transcript lines, with who said them and the line to jump to.
  const spoken = (await searchSessions('hi ana')).find((hit) => hit.id === id)
  const said = spoken?.matches.find((match) => match.field === 'transcript')
  if (said?.speaker !== 'Ben' || !said.line) fail(`transcript search missed: ${JSON.stringify(spoken)}`)
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
          // Fuzzy: a typo still finds the note, and the match carries highlighted runs.
          const hits = await window.api.searchPages('helo  SMOKE')
          const hit = hits.find((entry) => entry.id === created.id)
          const notesMatch = hit?.matches.find((match) => match.field === 'notes')
          if (!notesMatch?.parts.some((part) => part.hit)) {
            fail(fileFormat + ' search missed the page: ' + JSON.stringify(hits))
          }
          if ((await window.api.searchPages('hello nowhere-in-any-note')).length) fail('search matched a missing word')

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
        if ((await window.api.listPages()).some((page) => page.id === session.id)) fail('deleted session still listed')
        await window.api.restorePage(session.id)
        if (!(await window.api.listPages()).some((page) => page.id === session.id)) fail('restorePage did not bring the session back')
        const restoredTwice = await window.api.restorePage(session.id).then(() => true, () => false)
        if (restoredTwice) fail('restorePage restored a session that was not deleted')
        await window.api.deletePage(session.id)
        const missingPerson = await window.api.restorePerson('no-such-person').then(() => true, () => false)
        if (missingPerson) fail('restorePerson accepted an unknown id')

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
  registerRecorderIpc({ identifySpeakers: !isTestRun })
  // Evals set LYRA_RELABEL=0 to score live identification on its own.
  if (process.env.LYRA_RELABEL !== '0') {
    onRecordingFinished((recording) => {
      if (identifiesSpeakers()) void relabelSession(recording.pageId)
    })
  }
  registerMeetingPipeline()
  registerMeetingNotes()
  registerTitleSuggestions()
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
    // Sessions deleted before a crash were never emptied into the system trash.
    void emptySessionTrash()
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
  void flushAllSessions()
    .then(() => emptySessionTrash())
    .finally(() => {
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

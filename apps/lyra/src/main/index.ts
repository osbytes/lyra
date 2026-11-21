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
import { mkdirSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  createPage,
  deletePage,
  getPage,
  listPages,
  migrateLegacyPages,
  moveNotes,
  notesDir,
  savePage,
  startWatchingNotes
} from './pages'
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
import { listPeople } from './voices'
import { generateNotes, registerMeetingNotes } from './meeting/notes'
import { stopNotesWorker } from './meeting/notesLocal'
import { stopSpeakerWorker } from './meeting/speakers'
import { registerRecorderIpc, trackPath } from './recorder'
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#fafafa',
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
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
  ipcMain.on('log:write', (_event, scope: unknown, message: unknown, data: unknown) => {
    log(String(scope), String(message), data)
  })
  ipcMain.handle('whisper:warmUp', () => warmUp())
  ipcMain.handle('whisper:transcribe', (_event, payload: unknown, prompt: unknown) =>
    transcribePcm(pcmFromIpc(payload), typeof prompt === 'string' ? prompt : '')
  )
}

async function seedScreenshotPages(): Promise<void> {
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
  try {
    await seedScreenshotPages()
    const reloaded = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => {
        resolve()
      })
    })
    win.webContents.reload()
    await reloaded
    await new Promise((resolve) => setTimeout(resolve, 600))
    const image = await win.webContents.capturePage()
    const outDir = join(__dirname, '../../docs')
    const outPath = join(outDir, 'screenshot.png')
    await mkdir(outDir, { recursive: true })
    await writeFile(outPath, image.toPNG())
    process.stdout.write(`screenshot: ${outPath}
`)
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
    const started = Date.now()
    await processMeeting({ pageId: page.id, micPath, systemPath: null, seconds: 0 })
    const labeled = await getPage(page.id)
    const took = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(`meeting-fixture (${took} s):\n${labeled.body}\n`)

    // Name the first speaker and save their voice, as the speakers bar does.
    await assignSpeaker(page.id, 0, { name: 'Fixture Person', remember: true })
    const renamed = await getPage(page.id)
    const people = await listPeople()
    if (!renamed.body.includes('] Fixture Person: ') || people.length !== 1) {
      throw new Error('relabel did not update the note or save the voice')
    }
    process.stdout.write('meeting-fixture: relabel ok\n')

    // Optional: LYRA_NOTES_ENGINE=local|claude also writes meeting notes.
    const engine = process.env.LYRA_NOTES_ENGINE
    if (engine === 'local' || engine === 'claude') {
      overrideSettings({ notesEngine: engine })
      const notesStarted = Date.now()
      await generateNotes(page.id)
      const withNotes = await getPage(page.id)
      const notesTook = ((Date.now() - notesStarted) / 1000).toFixed(1)
      process.stdout.write(`meeting-fixture notes (${engine}, ${notesTook} s):\n${withNotes.body}\n`)
    }
    app.exit(0)
  } catch (error) {
    console.error('meeting-fixture failed', error)
    app.exit(1)
  }
}

async function runUiSmoke(win: BrowserWindow): Promise<void> {
  try {
    checkConsentParser()
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

        const meetingPage = await window.api.createPage()
        await window.api.startRecording(meetingPage.id, false)
        window.api.appendRecording('mic', new Int16Array(16000).fill(1000))
        const recording = await window.api.stopRecording()
        if (!recording || Math.abs(recording.seconds - 1) > 0.01 || recording.systemPath !== null) {
          fail('meeting recording was wrong: ' + JSON.stringify(recording))
        }
        await window.api.deletePage(meetingPage.id)

        for (const bad of ['../escape.txt', '..\\\\escape.txt', '.hidden.txt', 'x/y.txt', 'note.exe']) {
          const rejected = await window.api.getPage(bad).then(() => false, () => true)
          if (!rejected) fail('path guard let through ' + bad)
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
    createWindow()
  })
  broadcastStatus({ state: 'idle' })

  app.on('activate', () => {
    if (getMainWindow()) showMainWindow()
    else createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
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

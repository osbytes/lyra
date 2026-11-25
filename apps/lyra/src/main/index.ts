import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell
} from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { checkConfig, config, ConfigError, configSummary } from './config'
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
  openSessionFor,
  saveSessionPage as savePage
} from './sessionStore'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { registerMicPrompt, stopMicPrompt } from './micprompt'
import { registerOverlay, watchMainWindow } from './overlay'
import { getMainWindow, registerSessionIpc, setMainWindow, showMainWindow } from './session'
import { getSettings, onSettingsChanged, updateSettings } from './settings'
import { registerMeetingPipeline } from './meeting/pipeline'
import { registerKeyIpc } from './secrets'
import { createServices, type Services } from './services'
import { stopNotesWorker } from './meeting/notesLocal'
import { stopSpeakerWorker } from './meeting/speakers'
import { relabelSession } from './meeting/relabel'
import {
  finishRecordingForQuit,
  identifiesSpeakers,
  onRecordingFinished,
  registerRecorderIpc
} from './recorder'
import { startAudioRetention } from './audioRetention'
import { createTray } from './tray'
import { registerUpdater } from './updater'
import { broadcastStatus, warmUp } from './whisper'
import { log, logPath } from './log'
import { searchSessions } from './search'
import { closeSearchIndex, startSearchIndex } from './searchIndex/service'
import type { Task } from './tasks/args'
import { isTaskLaunch, prepareTaskProfile, runTaskIn, taskFromArgv } from './tasks/run'
import type { Page, Settings } from '../shared/types'

/**
 * Bad configuration (an environment variable or a task option) is found before anything else
 * runs; the app then only reports it and exits.
 */
function readStartup(): { task: Task | null; error: ConfigError | null } {
  const error = checkConfig()
  if (error) return { task: null, error }
  try {
    return { task: taskFromArgv(), error: null }
  } catch (caught) {
    if (caught instanceof ConfigError) return { task: null, error: caught }
    throw caught
  }
}

const startup = readStartup()
/** A one-off task from the command line (smoke test, screenshots, meeting replay), if any. */
const task = startup.task
const isTestRun = task !== null

if (task) prepareTaskProfile(task)

/** Set once the user really quits, so closing the window can mean "hide" until then. */
let quitting = false

/** Built once the app is ready and the configuration has been checked. */
let services: Services | null = null

// One Lyra at a time: a second launch focuses the first instead.
if (startup.error) {
  // Reported once the app is ready (dialogs need it); nothing else is set up.
} else if (!isTestRun && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

/** Passed by the login item so Lyra starts in the tray instead of opening its window. */
const HIDDEN_ARG = '--hidden'

function applyLoginItem(openAtLogin: boolean): void {
  if (isTestRun || !app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_ARG] })
}

/** Opened by the OS at login: stay in the tray (watching for meetings) until the user opens Lyra. */
function startedAtLogin(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
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

/** The app's top band (`--band` in styles.css), which the window controls share. */
const BAND_HEIGHT = 56

/**
 * Windows draws its caption buttons over the app's own top band instead of a separate title
 * bar, so the brand, the page toolbar and the window controls sit on one line. The buttons
 * take the page background (`--bg`) and muted text colour of the current theme.
 */
function captionOverlay(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#16161b', symbolColor: '#a3a3b2', height: BAND_HEIGHT }
    : { color: '#ffffff', symbolColor: '#5d5d6b', height: BAND_HEIGHT }
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
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: captionOverlay() }
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
  if (process.platform === 'win32') {
    const recolor = (): void => mainWindow.setTitleBarOverlay(captionOverlay())
    nativeTheme.on('updated', recolor)
    mainWindow.on('closed', () => nativeTheme.off('updated', recolor))
  }
  attachEditMenu(mainWindow)

  // Closing the window hides it; Lyra keeps running in the tray for the global hotkey.
  mainWindow.on('close', (event) => {
    if (quitting || isTestRun) return
    event.preventDefault()
    mainWindow.hide()
  })

  // Tasks run headless (the smoke test, evals and replays stay off screen and out of the way);
  // only screenshots need the window drawn.
  if ((!task && !startedAtLogin()) || task?.kind === 'screenshot') {
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

  if (task && services) runTaskIn(mainWindow, task, services)

  const { rendererUrl } = config()
  if (is.dev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
  // Sandboxed preloads no longer get Electron's clipboard module, so copying goes through main.
  ipcMain.on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
}


void app.whenReady().then(() => {
  if (startup.error) {
    log('app', 'bad configuration', startup.error.message)
    // A scripted task run has nobody to click a dialog away; the log line above is its report.
    if (!isTaskLaunch()) {
      dialog.showErrorBox('Lyra can’t start', `${startup.error.message}\n\nSee docs/CONFIG.md.`)
    }
    app.exit(1)
    return
  }
  electronApp.setAppUserModelId('com.voicepages.app')
  log('app', `started ${app.getVersion()}`, {
    log: logPath(),
    task: task?.kind ?? null,
    env: configSummary()
  })

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
  // device and the primary screen (its video track is discarded), so no picker shows.
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
  // A capture replay records through the window, so it needs the real recorder.
  const recordsForReal = !isTestRun || (task.kind === 'meeting' && task.capture)
  registerRecorderIpc({ identifySpeakers: recordsForReal, transcribe: recordsForReal })
  // Evals pass --no-relabel to score the track-labeled lines on their own.
  if (task?.kind !== 'meeting' || task.relabel) {
    onRecordingFinished((recording) => {
      if (identifiesSpeakers()) void relabelSession(recording.pageId)
    })
  }
  registerMeetingPipeline()
  services = createServices()
  services.notes.register()
  services.titles.register()
  registerKeyIpc()
  registerUpdater({ enabled: !isTestRun })
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
    startSearchIndex()
    startAudioRetention()
    createWindow()
  })
  broadcastStatus({ state: 'idle' })

  app.on('activate', () => {
    if (getMainWindow()) showMainWindow()
    else createWindow()
  })
})

/** Longest the app waits on its own shutdown work before quitting anyway. */
const QUIT_FLUSH_MS = 10_000

async function shutdownWork(): Promise<void> {
  await finishRecordingForQuit().catch((error: unknown) => {
    log('app', 'could not finish the recording on quit', error)
  })
  await flushAllSessions()
  await closeSearchIndex().catch((error: unknown) => {
    log('app', 'could not close the search index on quit', error)
  })
  await emptySessionTrash()
}

let flushed = false
app.on('before-quit', (event) => {
  quitting = true
  // Finish a recording in progress, write pending exports and compact session logs before the
  // process goes away, but never let a stuck disk or worker keep the app from quitting.
  if (flushed) return
  event.preventDefault()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
    }, QUIT_FLUSH_MS)
  })
  void Promise.race([shutdownWork().then(() => 'done' as const), timedOut])
    .then(
      (result) => {
        if (result === 'timeout') log('app', 'quit flush timed out; quitting', { ms: QUIT_FLUSH_MS })
      },
      (error: unknown) => {
        log('app', 'quit flush failed', error)
      }
    )
    .finally(() => {
      clearTimeout(timer)
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

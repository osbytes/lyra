import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { installAppMenu } from './appMenu'
import { isAppPage, type AppPages } from './appOrigin'
import { checkConfig, config, ConfigError, configSummary } from './config'
import { attachEditMenu } from './editMenu'
import {
  CreatePageArg,
  ModelNameArg,
  PageIdArg,
  parseSettingsPatch,
  PermissionKindArg,
  RetentionDaysArg,
  RevealTargetArg,
  SavePageArg,
  ServerUrlArg,
  SessionUpdateArg
} from './ipcSchemas'
import { migrateLegacyPages, resolveInNotes, startWatchingNotes } from './pages'
import {
  moveFromPreviousFolder,
  pickNotesFolder,
  revealNotesFolder,
  switchNotesFolder
} from './notesFolder'
import {
  applySessionUpdate,
  closeSessionFor,
  createSession as createPage,
  deleteSession as deletePage,
  emptySessionTrash,
  reexportDirtySessions,
  restoreSession,
  flushAllSessions,
  getSessionPage as getPage,
  listSessions as listPages,
  openSessionFor,
  saveSessionPage as savePage
} from './sessionStore'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { registerMicPrompt, stopMicPrompt } from './micprompt'
import { exportIgnoredApps, importIgnoredApps } from './ignoredAppsFile'
import { registerOverlay, watchMainWindow } from './overlay'
import { registerPowerHandling, watchSessionEnd } from './power'
import {
  getMainWindow,
  isFromMainWindow,
  registerSessionIpc,
  onSessionState,
  resetSessionState,
  setMainWindow,
  showMainWindow
} from './session'
import { getSettings, onSettingsChanged, updateSettings } from './settings'
import { registerMeetingPipeline } from './meeting/pipeline'
import { registerKeyIpc } from './secrets'
import { createServices, type Services } from './services'
import { releaseNotesModel, stopNotesWorker } from './meeting/notesLocal'
import { stopSpeakerWorker } from './meeting/speakers'
import { relabelSession } from './meeting/relabel'
import {
  finishRecordingForQuit,
  identifiesSpeakers,
  onRecordingFinished,
  registerRecorderIpc,
  repairInterruptedAudio
} from './recorder'
import { previewAudioSweep, startAudioRetention } from './audioRetention'
import { getDiagnostics, noteWhisperUsed, revealFolder } from './diagnostics'
import { cancelModelDownload } from './models'
import { detectServers, listServerModels, testWriter } from './notesServers'
import { openPermissionSettings, permissionStatus } from './permissions'
import { createTray } from './tray'
import { registerUpdater } from './updater'
import { broadcastStatus, warmUp } from './whisper'
import { log, logPath } from './log'
import { searchSessions } from './search'
import { closeSearchIndex, setIndexBusy, startSearchIndex } from './searchIndex/service'
import type { Task } from './tasks/args'
import { isTaskLaunch, prepareTaskProfile, runTaskIn, taskFromArgv } from './tasks/run'
import { rememberWindowBounds, savedWindowBounds } from './windowState'
import type { Settings } from '../shared/types'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Without these an error in a promise nobody awaited vanishes, and one thrown from an event
// handler shows Electron's dialog with no trace in the user's log. The message only: a stack can
// carry a note's text through an error message built from it, but the message alone is enough to
// find the place.
process.on('unhandledRejection', (reason) => {
  log('app', 'unhandled rejection', errorMessage(reason))
})
process.on('uncaughtException', (error) => {
  log('app', 'uncaught exception', errorMessage(error))
})

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

/** Finishes a recording and writes sessions before a power event; set once the app is ready. */
let saveForPower: ((reason: string) => Promise<void>) | null = null

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

/** Lyra's own pages: the bundled renderer, or the dev server in development. */
function appPages(): AppPages {
  return {
    rendererFile: join(__dirname, '../renderer/index.html'),
    devUrl: is.dev ? config().rendererUrl : null
  }
}

function isOwnWindow(contents: WebContents): boolean {
  return BrowserWindow.fromWebContents(contents) !== null
}

function isMainContents(contents: WebContents): boolean {
  return contents === getMainWindow()?.webContents
}

/**
 * Settings, keys and the notes folder are changed only from the main window. The overlay shares
 * its preload, and its page has no use for them.
 */
function requireMainWindow(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isFromMainWindow(event)) throw new Error('Not allowed from this window')
}

/** The app's top band (`--band` in styles.css), which the window controls share. */
const BAND_HEIGHT = 56

const DEFAULT_SIZE = { width: 1080, height: 720 }
const MIN_SIZE = { width: 760, height: 520 }

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

/** Renderer crashes in the last minute; past the limit the window is left alone. */
const rendererCrashes: number[] = []
const MAX_RENDERER_RELOADS = 3

/**
 * The main window's renderer died (crash, OOM, killed). Its recorder is gone with it, so main
 * finishes the recording it was feeding (its WAV headers and manifest are written, as on quit),
 * writes the sessions, and reloads the page.
 */
async function recoverMainWindow(win: BrowserWindow): Promise<void> {
  resetSessionState()
  await saveWork('renderer gone')
  const now = Date.now()
  while (rendererCrashes.length && now - (rendererCrashes[0] ?? now) > 60_000) rendererCrashes.shift()
  if (rendererCrashes.length >= MAX_RENDERER_RELOADS) {
    log('app', 'renderer keeps crashing; not reloading again', { crashes: rendererCrashes.length })
    return
  }
  rendererCrashes.push(now)
  if (!win.isDestroyed()) win.webContents.reload()
}

function createWindow(): void {
  const icon = appIcon()
  // Task runs keep the fixed size (screenshots depend on it) and a throwaway profile anyway.
  const restored = isTestRun ? null : savedWindowBounds(MIN_SIZE)
  const mainWindow = new BrowserWindow({
    width: restored?.bounds.width ?? DEFAULT_SIZE.width,
    height: restored?.bounds.height ?? DEFAULT_SIZE.height,
    ...(restored ? { x: restored.bounds.x, y: restored.bounds.y } : {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
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
  if (!isTestRun) rememberWindowBounds(mainWindow)
  if (saveForPower) watchSessionEnd(mainWindow, saveForPower)
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
  mainWindow.on('unresponsive', () => {
    log('app', 'main window unresponsive')
  })
  mainWindow.on('responsive', () => {
    log('app', 'main window responsive again')
  })

  // Tasks run headless (the smoke test, evals and replays stay off screen and out of the way);
  // only screenshots need the window drawn.
  if ((!task && !startedAtLogin()) || task?.kind === 'screenshot') {
    mainWindow.on('ready-to-show', () => {
      // Maximizing shows the window, so it waits until the window is to be shown anyway.
      if (restored?.maximized) mainWindow.maximize()
      mainWindow.show()
    })
  }

  if (task && services) runTaskIn(mainWindow, task, services)

  const { rendererUrl } = config()
  if (is.dev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * `settings:update`. The notes folder can only be set this way in task runs; the app changes it
 * through `settings:pickFolder`, so the renderer never names a folder.
 */
async function updateSettingsFromRenderer(raw: unknown): Promise<Settings> {
  const { patch, dropped } = parseSettingsPatch(raw, { allowNotesDir: isTestRun })
  if (dropped.length) log('settings', 'dropped invalid fields', dropped)
  const { notesDir: folder, ...rest } = patch
  if (folder !== undefined) await switchNotesFolder(folder)
  return updateSettings(rest)
}

function registerIpc(): void {
  ipcMain.handle('pages:list', () => listPages())
  ipcMain.handle('pages:search', (_event, query: unknown) =>
    typeof query === 'string' ? searchSessions(query.slice(0, 200)) : []
  )
  ipcMain.handle('pages:get', (_event, id: unknown) => getPage(PageIdArg.parse(id)))
  ipcMain.handle('pages:create', (_event, options: unknown) => createPage(CreatePageArg.parse(options)))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (event, patch: unknown) => {
    requireMainWindow(event)
    return updateSettingsFromRenderer(patch)
  })
  ipcMain.handle('settings:pickFolder', (event) => {
    requireMainWindow(event)
    return pickNotesFolder(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('prompts:exportIgnored', (event) => {
    requireMainWindow(event)
    return exportIgnoredApps(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('prompts:importIgnored', (event) => {
    requireMainWindow(event)
    return importIgnoredApps(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('notes:move', (event) => {
    requireMainWindow(event)
    return moveFromPreviousFolder()
  })
  ipcMain.handle('notes:reveal', (event) => {
    requireMainWindow(event)
    return revealNotesFolder()
  })
  ipcMain.handle('pages:save', (_event, page: unknown) => savePage(SavePageArg.parse(page)))
  ipcMain.handle('pages:delete', (_event, id: unknown) => deletePage(PageIdArg.parse(id)))
  ipcMain.handle('pages:restore', (_event, id: unknown) => restoreSession(PageIdArg.parse(id)))
  ipcMain.handle('pages:reveal', (_event, id: unknown) => {
    shell.showItemInFolder(resolveInNotes(PageIdArg.parse(id)))
  })
  ipcMain.handle('sessions:open', (event, id: unknown) =>
    openSessionFor(PageIdArg.parse(id), event.sender.id)
  )
  ipcMain.handle('sessions:update', (event, id: unknown, update: unknown) =>
    applySessionUpdate(PageIdArg.parse(id), SessionUpdateArg.parse(update), event.sender.id)
  )
  ipcMain.on('sessions:close', (event, id: unknown) => {
    const parsed = PageIdArg.safeParse(id)
    if (parsed.success) closeSessionFor(parsed.data, event.sender.id)
  })
  ipcMain.on('log:write', (_event, scope: unknown, message: unknown, data: unknown) => {
    log(String(scope), String(message), data)
  })
  ipcMain.handle('whisper:warmUp', async () => {
    await warmUp()
    noteWhisperUsed()
  })
  // Sandboxed preloads no longer get Electron's clipboard module, so copying goes through main.
  ipcMain.on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  registerSettingsToolsIpc()
}

/** Settings' helpers: retention preview, summary servers, About, permissions, downloads. */
function registerSettingsToolsIpc(): void {
  ipcMain.handle('retention:preview', (event, days: unknown) => {
    requireMainWindow(event)
    return previewAudioSweep(RetentionDaysArg.parse(days))
  })
  // These three reach the network, so each runs only from a click in Settings.
  ipcMain.handle('notes:detectServers', (event) => {
    requireMainWindow(event)
    return detectServers()
  })
  ipcMain.handle('notes:listModels', (event, baseUrl: unknown) => {
    requireMainWindow(event)
    return listServerModels(ServerUrlArg.parse(baseUrl))
  })
  ipcMain.handle('notes:testWriter', (event) => {
    requireMainWindow(event)
    return testWriter()
  })
  ipcMain.handle('diagnostics:get', (event) => {
    requireMainWindow(event)
    return getDiagnostics()
  })
  ipcMain.handle('diagnostics:reveal', (event, target: unknown) => {
    requireMainWindow(event)
    return revealFolder(RevealTargetArg.parse(target))
  })
  ipcMain.handle('models:cancel', (event, name: unknown) => {
    requireMainWindow(event)
    const cancelled = cancelModelDownload(ModelNameArg.parse(name))
    if (cancelled) log('models', 'download cancelled from the window')
    return cancelled
  })
  ipcMain.handle('permissions:status', () => permissionStatus())
  ipcMain.handle('permissions:openSettings', (event, kind: unknown) => {
    requireMainWindow(event)
    return openPermissionSettings(PermissionKindArg.parse(kind))
  })
}

/**
 * Every window, including ones created later (the overlay) or by accident: no navigation away
 * from the app's page, no new windows (web links go to the OS browser), no `<webview>`.
 */
function lockDownContents(contents: WebContents): void {
  // Only hand web links to the OS; file:, smb:, custom-protocol URLs etc. can launch local code.
  contents.setWindowOpenHandler((details) => {
    if (isWebUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

app.on('web-contents-created', (_event, contents) => {
  lockDownContents(contents)
})

/**
 * The microphone only for the main window on the app's own page (the overlay never records);
 * clipboard writes for any of the app's windows on its page. Everything else is refused.
 */
function registerPermissions(): void {
  const pages = appPages()
  const allowed = (contents: WebContents | null, permission: string, url: string): boolean => {
    if (!contents || !isAppPage(url, pages)) return false
    if (permission === 'media') return isMainContents(contents)
    if (permission === 'clipboard-sanitized-write') return isOwnWindow(contents)
    return false
  }
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowed(contents, permission, details.requestingUrl ?? contents?.getURL() ?? '')
  )
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Lyra records sound only; a request for the camera is not one of its own.
    const video = 'mediaTypes' in details && (details.mediaTypes ?? []).includes('video')
    callback(!video && allowed(contents, permission, details.requestingUrl))
  })
  // Meetings ask for system audio via getDisplayMedia; answer with the loopback
  // device and the primary screen (its video track is discarded), so no picker shows.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const main = getMainWindow()
    const frame = request.frame
    if (!main || frame?.top !== main.webContents.mainFrame || !isAppPage(frame.url, pages)) {
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
}

/** Renderer and helper process deaths go to the log; the main window's renderer is recovered. */
function watchProcesses(): void {
  app.on('render-process-gone', (_event, contents, details) => {
    const main = getMainWindow()
    const isMain = main !== null && contents === main.webContents
    log('app', 'renderer gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      window: isMain ? 'main' : 'other'
    })
    if (!isMain || quitting || details.reason === 'clean-exit') return
    // A task run has nobody to recover for; a crash is its failure.
    if (isTestRun) {
      app.exit(1)
      return
    }
    void recoverMainWindow(main)
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log('app', 'child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name ?? null,
      service: details.serviceName ?? null
    })
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

  installAppMenu({ developer: is.dev })
  registerPermissions()
  watchProcesses()

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
  registerUpdater({
    enabled: !isTestRun,
    beforeInstall: () => {
      quitting = true
    }
  })
  saveForPower = registerPowerHandling(saveWork)
  // While recording, Whisper gets the machine: the embedding backlog waits and the notes model
  // (a few GB) lets go of its memory.
  let wasRecording = false
  onSessionState((state) => {
    const recording = state.phase !== 'idle'
    if (recording === wasRecording) return
    wasRecording = recording
    setIndexBusy('recording', recording)
    // A recording transcribes as it goes, so Whisper's backend is now a fact, not a plan.
    if (recording) noteWhisperUsed()
    if (recording) releaseNotesModel()
  })
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
  void migrateLegacyPages().finally(async () => {
    // A crash mid-recording leaves WAV headers that say "no audio"; fix them before anything reads.
    await repairInterruptedAudio().catch((error: unknown) => {
      log('app', 'could not repair interrupted audio', error instanceof Error ? error.message : String(error))
    })
    // Sessions deleted before a crash were never emptied into the system trash.
    void emptySessionTrash()
    // A crash mid-export leaves a note file behind its document.
    void reexportDirtySessions()
    startWatchingNotes()
    startSearchIndex()
    // Embedding old sessions can wait for the charger.
    setIndexBusy('battery', powerMonitor.isOnBatteryPower())
    powerMonitor.on('on-battery', () => {
      setIndexBusy('battery', true)
    })
    powerMonitor.on('on-ac', () => {
      setIndexBusy('battery', false)
    })
    startAudioRetention()
    createWindow()
  })
  broadcastStatus({ state: 'idle' })

  app.on('activate', () => {
    if (getMainWindow()) showMainWindow()
    else createWindow()
  })
})

/** Longest the app waits on all its own shutdown work before quitting anyway. */
const QUIT_FLUSH_MS = 12_000
/** Each step's own bound, so one slow step can't use up the others' time. */
const RECORDING_FINISH_MS = 8_000
const SESSION_FLUSH_MS = 3_000
const CLEANUP_MS = 2_000

/** Waits for `work`, at most `ms`; a failure or a timeout is logged, never thrown. */
async function within(step: string, work: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
    }, ms)
  })
  try {
    const result = await Promise.race([work().then(() => 'done' as const), timedOut])
    if (result === 'timeout') log('app', `${step} timed out`, { ms })
  } catch (error) {
    log('app', `${step} failed`, errorMessage(error))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Finishes a recording in progress and writes the sessions: on quit, before sleep or shutdown,
 * and after the renderer dies. The session flush doesn't wait for the recording: a slow finish
 * (Whisper still working through the last chunks) must not keep notes from being written. Once
 * the recording is done, its last lines are flushed too.
 */
async function saveWork(reason: string): Promise<void> {
  log('app', 'saving work', { reason })
  const recording = within('finish recording', finishRecordingForQuit, RECORDING_FINISH_MS)
  const sessions = within('flush sessions', flushAllSessions, SESSION_FLUSH_MS)
  await Promise.all([recording, sessions])
  await within('flush sessions after the recording', flushAllSessions, SESSION_FLUSH_MS)
}

async function shutdownWork(): Promise<void> {
  await saveWork('quit')
  await within('close the search index', closeSearchIndex, CLEANUP_MS)
  await within('empty the session trash', emptySessionTrash, CLEANUP_MS)
}

let flushed = false
app.on('before-quit', (event) => {
  quitting = true
  // Finish a recording in progress, write pending exports and compact session logs before the
  // process goes away, but never let a stuck disk or worker keep the app from quitting.
  if (flushed) return
  event.preventDefault()
  void within('quit flush', shutdownWork, QUIT_FLUSH_MS).finally(() => {
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

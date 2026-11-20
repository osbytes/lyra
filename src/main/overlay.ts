import { is } from '@electron-toolkit/utils'
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { log } from './log'
import type { SessionState } from '../shared/types'
import {
  getMainWindow,
  getSessionState,
  onOverlayFrame,
  onSessionState
} from './session'

const WIDTH = 380
const HEIGHT = 64
const MARGIN = 24

let overlay: BrowserWindow | null = null

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steal focus from whatever the user is typing into.
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
  win.on('closed', () => {
    if (overlay === win) overlay = null
  })
  return win
}

function place(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setPosition(
    Math.round(workArea.x + (workArea.width - WIDTH) / 2),
    Math.round(workArea.y + workArea.height - HEIGHT - MARGIN)
  )
}

/** The main window is what the user is looking at, so the pill would be redundant. */
function mainWindowInView(): boolean {
  const main = getMainWindow()
  return !!main && main.isVisible() && !main.isMinimized() && main.isFocused()
}

function update(state: SessionState): void {
  const active = state.phase !== 'idle'
  if (!active) {
    overlay?.hide()
    overlay?.webContents.send('session:state', state)
    return
  }
  overlay ??= createOverlay()
  overlay.webContents.send('session:state', state)
  if (mainWindowInView()) {
    overlay.hide()
  } else if (!overlay.isVisible()) {
    place(overlay)
    overlay.showInactive()
    log('overlay', 'shown', { phase: state.phase })
  }
}

/** A small always-on-top pill that shows recording progress while Lyra's window is hidden. */
export function registerOverlay(): void {
  onSessionState(update)
  onOverlayFrame((frame) => {
    if (overlay?.isVisible()) overlay.webContents.send('overlay:frame', frame)
  })
}

/** Re-evaluates visibility when the main window gains or loses focus. */
export function watchMainWindow(win: BrowserWindow): void {
  const recheck = (): void => {
    update(getSessionState())
  }
  win.on('focus', recheck)
  win.on('blur', recheck)
  win.on('hide', recheck)
  win.on('show', recheck)
  win.on('minimize', recheck)
}

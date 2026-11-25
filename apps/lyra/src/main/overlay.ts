import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow, screen } from 'electron'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config'
import { log } from './log'
import type { MicPrompt, SessionState } from '../shared/types'
import {
  getMainWindow,
  getSessionState,
  onOverlayFrame,
  onSessionState
} from './session'

const WIDTH = 340
const PILL_HEIGHT = 44
/** Room for the question, the shortcut line and a row of buttons. */
const PROMPT_HEIGHT = 152
const MARGIN = 24
/** Long enough to read and reach with the pointer; the prompt is the way into meeting capture. */
const PROMPT_TIMEOUT_MS = 20_000
/** While the pointer rests on the card it stays; this is how often that's checked. */
const PROMPT_HOVER_CHECK_MS = 1_000

let overlay: BrowserWindow | null = null
let prompt: MicPrompt | null = null
let promptTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Where the user last dragged the window: its left edge and bottom edge, so the taller prompt
 * grows upward from the same spot. `undefined` until read from disk; `null` means the default.
 */
type Anchor = { x: number; bottom: number }
let anchor: Anchor | null | undefined
/** The bounds `place()` last set, so its own move isn't mistaken for a drag. */
let placed: { x: number; y: number } | null = null

function anchorPath(): string {
  return join(app.getPath('userData'), 'overlay-position.json')
}

function readAnchor(): Anchor | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(anchorPath(), 'utf8'))
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'x' in raw &&
      'bottom' in raw &&
      typeof raw.x === 'number' &&
      typeof raw.bottom === 'number'
    ) {
      return { x: raw.x, bottom: raw.bottom }
    }
  } catch {
    // Never moved, or an unreadable file: use the default spot.
  }
  return null
}

function saveAnchor(win: BrowserWindow): void {
  const bounds = win.getBounds()
  if (placed?.x === bounds.x && placed.y === bounds.y) return
  anchor = { x: bounds.x, bottom: bounds.y + bounds.height }
  writeFile(anchorPath(), JSON.stringify(anchor), 'utf8').catch((error: unknown) => {
    log('overlay', 'could not save position', {
      error: error instanceof Error ? error.message : String(error)
    })
  })
}

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: PILL_HEIGHT,
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
    // macOS: a non-activating panel, which may float over another app's full-screen window.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
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
  // Without `skipTransformProcessType`, asking to be visible over full-screen apps turns the
  // whole app into a background agent on macOS: no Dock icon, no Cmd+Tab, so once the main window
  // is hidden there is no way back to it. The panel type (above) is what lets the pill sit over
  // a full-screen call without that.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }

  const { rendererUrl } = config()
  if (is.dev && rendererUrl) {
    void win.loadURL(`${rendererUrl}#overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
  win.on('moved', () => {
    saveAnchor(win)
  })
  win.on('closed', () => {
    if (overlay === win) overlay = null
  })
  // A dead page can't be reloaded into a useful state mid-prompt; the next show builds a new one.
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.destroy()
  })
  return win
}

/** The user's spot when it's still on a connected screen (kept inside it), else bottom centre. */
function place(win: BrowserWindow, height: number): void {
  if (anchor === undefined) anchor = readAnchor()
  let x: number
  let y: number
  if (anchor) {
    const { workArea } = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.bottom })
    x = Math.min(Math.max(anchor.x, workArea.x), workArea.x + workArea.width - WIDTH)
    y = Math.min(Math.max(anchor.bottom - height, workArea.y), workArea.y + workArea.height - height)
  } else {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    x = workArea.x + (workArea.width - WIDTH) / 2
    y = workArea.y + workArea.height - height - MARGIN
  }
  placed = { x: Math.round(x), y: Math.round(y) }
  win.setBounds({ ...placed, width: WIDTH, height })
}

/** The main window is what the user is looking at, so the pill would be redundant. */
function mainWindowInView(): boolean {
  const main = getMainWindow()
  return !!main && main.isVisible() && !main.isMinimized() && main.isFocused()
}

function update(state: SessionState): void {
  const active = state.phase !== 'idle'
  if (!active) {
    overlay?.webContents.send('session:state', state)
    if (!prompt) overlay?.hide()
    return
  }
  const hadPrompt = prompt !== null
  clearPrompt()
  overlay ??= createOverlay()
  overlay.webContents.send('session:state', state)
  if (mainWindowInView()) {
    overlay.hide()
  } else if (!overlay.isVisible() || hadPrompt) {
    place(overlay, PILL_HEIGHT)
    overlay.showInactive()
    log('overlay', 'shown', { phase: state.phase })
  }
}

function clearPrompt(): void {
  if (promptTimer) clearTimeout(promptTimer)
  promptTimer = null
  if (!prompt) return
  prompt = null
  overlay?.webContents.send('prompt:show', null)
}

/** Shows the "mic in use" card; it hides itself after a while unless the pointer is on it. */
export function showPrompt(next: MicPrompt): void {
  if (getSessionState().phase !== 'idle') return
  prompt = next
  const win = (overlay ??= createOverlay())
  const send = (): void => {
    win.webContents.send('prompt:show', next)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
  place(win, PROMPT_HEIGHT)
  win.showInactive()
  if (promptTimer) clearTimeout(promptTimer)
  promptTimer = setTimeout(expirePrompt, PROMPT_TIMEOUT_MS)
}

/**
 * Whether the pointer is over the card. Checked here rather than reported by the page: no IPC
 * carries hover from it, and a window that can't take focus doesn't get pointer moves on every
 * platform.
 */
function pointerOnOverlay(): boolean {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return false
  const point = screen.getCursorScreenPoint()
  const bounds = overlay.getBounds()
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  )
}

function expirePrompt(): void {
  promptTimer = null
  if (!prompt) return
  if (pointerOnOverlay()) {
    promptTimer = setTimeout(expirePrompt, PROMPT_HOVER_CHECK_MS)
    return
  }
  hidePrompt()
}

export function hidePrompt(): void {
  if (!prompt) return
  clearPrompt()
  if (getSessionState().phase === 'idle') overlay?.hide()
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

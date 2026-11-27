import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { OverlayFrame, SessionState, type SessionCommand } from '../shared/types'
import { log } from './log'

/**
 * Relays recording state between the main window (which owns the microphone and
 * the transcriber) and everything else that shows or controls it: the tray, the
 * global hotkey, and the overlay pill.
 */

let mainWindow: BrowserWindow | null = null
let state: SessionState = { phase: 'idle', startedAt: null, micName: '', systemAudio: false }
const listeners = new Set<(state: SessionState) => void>()
const frameListeners = new Set<(frame: OverlayFrame) => void>()

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/**
 * Whether an IPC message came from the main window. The overlay loads the same preload, so
 * channels that change settings, keys or files check this instead of trusting any window.
 */
export function isFromMainWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = getMainWindow()
  return win !== null && event.sender === win.webContents
}

export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function getSessionState(): SessionState {
  return state
}

export function isRecording(): boolean {
  return state.phase !== 'idle'
}

export function onSessionState(listener: (state: SessionState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function onOverlayFrame(listener: (frame: OverlayFrame) => void): () => void {
  frameListeners.add(listener)
  return () => frameListeners.delete(listener)
}

export function sendSessionCommand(command: SessionCommand): void {
  const win = getMainWindow()
  if (!win) {
    log('session', 'no main window for command', command)
    return
  }
  win.webContents.send('session:command', command)
}

export function toggleSession(): void {
  sendSessionCommand({ type: 'toggle' })
}

function publish(next: SessionState): void {
  const changed = next.phase !== state.phase
  state = next
  if (changed) log('session', `phase ${next.phase}`)
  for (const listener of listeners) listener(state)
}

/**
 * Back to idle when the main window's renderer is gone: it can no longer report, and the tray,
 * the overlay and the sleep blocker would otherwise think it is still recording.
 */
export function resetSessionState(): void {
  if (state.phase === 'idle') return
  publish({ phase: 'idle', startedAt: null, micName: '', systemAudio: false })
}

export function registerSessionIpc(): void {
  ipcMain.on('session:report', (event, value: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return
    const next = SessionState.safeParse(value)
    if (next.success) publish(next.data)
  })
  ipcMain.on('overlay:frame', (event, value: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return
    const frame = OverlayFrame.safeParse(value)
    if (!frame.success) return
    for (const listener of frameListeners) listener(frame.data)
  })
  ipcMain.handle('session:get', () => state)
  ipcMain.on('session:requestStop', () => {
    sendSessionCommand({ type: 'stop' })
  })
  ipcMain.on('window:showMain', () => {
    showMainWindow()
  })
}

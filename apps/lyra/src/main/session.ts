import { ipcMain, type BrowserWindow } from 'electron'
import type { OverlayFrame, SessionCommand, SessionPhase, SessionState } from '../shared/types'
import { log } from './log'

/**
 * Relays recording state between the main window (which owns the microphone and
 * the transcriber) and everything else that shows or controls it: the tray, the
 * global hotkey, and the overlay pill.
 */

const PHASES: readonly SessionPhase[] = ['idle', 'starting', 'listening', 'finishing']

let mainWindow: BrowserWindow | null = null
let state: SessionState = { phase: 'idle', startedAt: null, micName: '' }
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

function parseState(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const phase = PHASES.find((p) => p === raw.phase)
  if (!phase) return null
  return {
    phase,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null,
    micName: typeof raw.micName === 'string' ? raw.micName : ''
  }
}

function parseFrame(value: unknown): OverlayFrame | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.level !== 'number' || typeof raw.status !== 'string') return null
  return { level: Math.max(0, Math.min(1, raw.level)), status: raw.status.slice(0, 80) }
}

export function registerSessionIpc(): void {
  ipcMain.on('session:report', (event, value: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return
    const next = parseState(value)
    if (!next) return
    const changed = next.phase !== state.phase
    state = next
    if (changed) log('session', `phase ${next.phase}`)
    for (const listener of listeners) listener(state)
  })
  ipcMain.on('overlay:frame', (event, value: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return
    const frame = parseFrame(value)
    if (!frame) return
    for (const listener of frameListeners) listener(frame)
  })
  ipcMain.handle('session:get', () => state)
  ipcMain.on('session:requestStop', () => {
    sendSessionCommand({ type: 'stop' })
  })
  ipcMain.on('window:showMain', () => {
    showMainWindow()
  })
}

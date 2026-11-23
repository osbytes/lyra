import { BrowserWindow, globalShortcut, ipcMain } from 'electron'
import type { HotkeyAction, HotkeyStatus, Settings } from '../shared/types'
import { log } from './log'
import { toggleSession } from './session'
import { getSettings, onSettingsChanged } from './settings'

const ACTIONS: readonly HotkeyAction[] = ['session']
const SETTING: Record<HotkeyAction, 'hotkey'> = {
  session: 'hotkey'
}

const statuses = new Map<HotkeyAction, HotkeyStatus>()

function list(): HotkeyStatus[] {
  return ACTIONS.flatMap((action) => {
    const status = statuses.get(action)
    return status ? [status] : []
  })
}

function broadcast(): void {
  const value = list()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('hotkey:status', value)
}

function register(action: HotkeyAction, accelerator: string): void {
  const previous = statuses.get(action)
  if (previous?.registered) globalShortcut.unregister(previous.accelerator)

  let status: HotkeyStatus = { action, accelerator, registered: false, error: null }
  if (!accelerator.trim()) {
    // Empty means "no shortcut".
  } else {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        toggleSession()
      })
      status = ok
        ? { ...status, registered: true }
        : { ...status, error: 'Another app is already using this shortcut.' }
    } catch (error) {
      status = { ...status, error: 'Not a valid shortcut.' }
      log('hotkey', 'invalid accelerator', { action, accelerator, error: String(error) })
    }
  }

  statuses.set(action, status)
  log('hotkey', status.registered ? 'registered' : 'not registered', status)
}

function registerAll(settings: Settings): void {
  for (const action of ACTIONS) register(action, settings[SETTING[action]])
  broadcast()
}

/** Registers the global session shortcut and keeps it in sync with settings. */
export function registerHotkeys(): void {
  ipcMain.handle('hotkey:status', () => list())
  registerAll(getSettings())
  onSettingsChanged((next, prev) => {
    if (ACTIONS.some((action) => next[SETTING[action]] !== prev[SETTING[action]])) {
      globalShortcut.unregisterAll()
      statuses.clear()
      registerAll(next)
    }
  })
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}

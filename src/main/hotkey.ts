import { BrowserWindow, globalShortcut, ipcMain } from 'electron'
import type { HotkeyStatus } from '../shared/types'
import { log } from './log'
import { toggleSession } from './session'
import { getSettings, onSettingsChanged } from './settings'

let status: HotkeyStatus = { accelerator: '', registered: false, error: null }

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('hotkey:status', status)
}

function register(accelerator: string): void {
  if (status.registered) globalShortcut.unregister(status.accelerator)
  status = { accelerator, registered: false, error: null }

  if (accelerator.trim()) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        toggleSession('dictation')
      })
      status = ok
        ? { accelerator, registered: true, error: null }
        : { accelerator, registered: false, error: 'Another app is already using this shortcut.' }
    } catch (error) {
      status = { accelerator, registered: false, error: 'Not a valid shortcut.' }
      log('hotkey', 'invalid accelerator', { accelerator, error: String(error) })
    }
  }

  log('hotkey', status.registered ? 'registered' : 'not registered', status)
  broadcast()
}

/** Registers the global "start dictation" shortcut and keeps it in sync with settings. */
export function registerHotkeys(): void {
  ipcMain.handle('hotkey:status', () => status)
  register(getSettings().hotkey)
  onSettingsChanged((next, prev) => {
    if (next.hotkey !== prev.hotkey) register(next.hotkey)
  })
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}

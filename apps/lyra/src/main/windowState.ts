import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'
import { fitToScreens, WindowState, type Rect } from './windowBounds'

const SAVE_DELAY_MS = 500

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function readState(): WindowState | null {
  try {
    const parsed = WindowState.safeParse(JSON.parse(readFileSync(statePath(), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    // First run, or an unreadable file: the default size.
    return null
  }
}

/**
 * The main window's last size and position, fitted to the screens connected now, or null for
 * the default. `maximized` is applied after the window is created.
 */
export function savedWindowBounds(min: { width: number; height: number }): {
  bounds: Rect
  maximized: boolean
} | null {
  const state = readState()
  if (!state) return null
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  const bounds = fitToScreens(state, areas, min)
  return bounds ? { bounds, maximized: state.maximized } : null
}

/** Saves the window's normal (un-maximized) bounds whenever it moves or resizes, and on close. */
export function rememberWindowBounds(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const state: WindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    const path = statePath()
    writeFile(`${path}.tmp`, JSON.stringify(state), 'utf8')
      .then(() => rename(`${path}.tmp`, path))
      .catch((error: unknown) => {
        log('window', 'could not save bounds', { error: error instanceof Error ? error.message : String(error) })
      })
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', save)
}

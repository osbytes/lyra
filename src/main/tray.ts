import { app, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import type { SessionState } from '../shared/types'
import { notesDir } from './pages'
import { getSessionState, onSessionState, sendSessionCommand, showMainWindow, toggleSession } from './session'
import { getSettings, onSettingsChanged } from './settings'

let tray: Tray | null = null

function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (image.isEmpty()) return image
  const size = process.platform === 'darwin' ? 18 : 16
  return image.resize({ width: size, height: size, quality: 'best' })
}

function readableAccelerator(accelerator: string): string {
  const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'
  return accelerator.replace('CommandOrControl', mod).replace('CmdOrCtrl', mod)
}

function buildMenu(state: SessionState): Menu {
  const recording = state.phase !== 'idle'
  return Menu.buildFromTemplate([
    recording
      ? {
          label: 'Stop recording',
          click: () => {
            sendSessionCommand({ type: 'stop' })
          }
        }
      : {
          label: 'Start dictation',
          accelerator: getSettings().hotkey || undefined,
          registerAccelerator: false,
          click: () => {
            toggleSession('dictation')
          }
        },
    ...(recording
      ? []
      : [
          {
            label: 'Start meeting',
            accelerator: getSettings().meetingHotkey || undefined,
            registerAccelerator: false,
            click: () => {
              toggleSession('meeting')
            }
          }
        ]),
    { type: 'separator' },
    { label: 'Open Lyra', click: showMainWindow },
    {
      label: 'Open notes folder',
      click: () => {
        void shell.openPath(notesDir())
      }
    },
    { type: 'separator' },
    { label: 'Quit Lyra', role: 'quit' }
  ])
}

function refresh(state: SessionState): void {
  if (!tray) return
  const recording = state.phase === 'listening' || state.phase === 'starting'
  const hotkey = getSettings().hotkey
  tray.setToolTip(
    recording ? 'Lyra — recording' : `Lyra${hotkey ? ` — ${readableAccelerator(hotkey)} to dictate` : ''}`
  )
  if (process.platform === 'darwin') tray.setTitle(recording ? '●' : '')
  tray.setContextMenu(buildMenu(state))
}

/** Puts Lyra in the system tray / menu bar so it keeps running with no window open. */
export function createTray(): void {
  if (tray) return
  tray = new Tray(trayIcon())
  // Windows and Linux open the app on a plain click; macOS shows the menu.
  if (process.platform !== 'darwin') tray.on('click', showMainWindow)
  refresh(getSessionState())
  onSessionState(refresh)
  onSettingsChanged((next, prev) => {
    if (next.hotkey !== prev.hotkey) refresh(getSessionState())
  })
  app.on('before-quit', () => {
    tray?.destroy()
    tray = null
  })
}

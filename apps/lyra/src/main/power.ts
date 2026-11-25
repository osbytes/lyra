import { app, powerMonitor, powerSaveBlocker, type BrowserWindow } from 'electron'
import { log } from './log'
import { isRecording, onSessionState, sendSessionCommand } from './session'

/**
 * Keeps a recording alive and its data safe across power events:
 *
 * - While recording, the system may not idle-sleep (a laptop left on the table in an in-person
 *   meeting would otherwise sleep mid-sentence). The display may still turn off.
 * - Before the machine sleeps or shuts down, and when Windows ends the user's session, the
 *   recording is finished and sessions are written, as on quit. Windows doesn't emit
 *   `before-quit` at shutdown or logoff, so without this a recording there is cut off unreadable.
 */
export function registerPowerHandling(
  saveWork: (reason: string) => Promise<void>
): (reason: string) => Promise<void> {
  let blocker: number | null = null
  onSessionState((state) => {
    const active = state.phase !== 'idle'
    if (active && blocker === null) {
      blocker = powerSaveBlocker.start('prevent-app-suspension')
      log('power', 'holding off sleep while recording')
    } else if (!active && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
      log('power', 'sleep allowed again')
    }
  })

  let saving: Promise<void> | null = null
  const save = (reason: string): Promise<void> => {
    if (saving) return saving
    log('power', 'saving before power event', { reason })
    // The window's recorder stops too, so it doesn't carry on as if nothing happened on wake.
    if (isRecording()) sendSessionCommand({ type: 'stop' })
    saving = saveWork(reason).finally(() => {
      saving = null
    })
    return saving
  }

  powerMonitor.on('suspend', () => {
    void save('suspend')
  })
  // macOS and Linux: quit through the normal path, which saves the same way before exiting.
  powerMonitor.on('shutdown', () => {
    log('power', 'system shutting down')
    app.quit()
  })
  return save
}

/**
 * Windows: the user is logging off or the machine is shutting down, which skips `before-quit`.
 * `save` is what `registerPowerHandling` returned; a second call while one runs joins it.
 */
export function watchSessionEnd(win: BrowserWindow, save: (reason: string) => Promise<void>): void {
  if (process.platform !== 'win32') return
  win.on('query-session-end', () => {
    void save('session-end')
  })
  win.on('session-end', () => {
    void save('session-end')
  })
}

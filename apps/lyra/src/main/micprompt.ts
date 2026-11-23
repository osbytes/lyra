import { ipcMain } from 'electron'
import type { PromptAnswer } from '../shared/types'
import { log } from './log'
import { MicWatcher, type MicUsers } from './micwatch'
import { hidePrompt, showPrompt } from './overlay'
import { isRecording, onSessionState, toggleSession } from './session'
import { getSettings, onSettingsChanged, updateSettings } from './settings'

const ANSWERS: readonly PromptAnswer[] = ['start', 'dismiss', 'ignore']

/** Apps using the mic at the last poll. */
let previous: MicUsers = new Set()
/** Apps we already asked about during their current mic use. */
const asked = new Set<string>()
let current: string | null = null

function ignored(appName: string): boolean {
  const name = appName.toLowerCase()
  return getSettings().micPrompt.ignoredApps.some((entry) => entry.toLowerCase() === name)
}

function onUsers(users: MicUsers): void {
  // Forget apps that released the mic, so their next use can prompt again.
  for (const name of asked) if (!users.has(name)) asked.delete(name)
  if (current !== null && !users.has(current)) {
    hidePrompt()
    current = null
  }

  if (!isRecording()) {
    for (const name of users) {
      if (previous.has(name) || asked.has(name) || ignored(name)) continue
      asked.add(name)
      current = name
      log('micprompt', 'asking', { app: name || 'unknown' })
      showPrompt({ app: name })
      break
    }
  }
  previous = users
}

const watcher = new MicWatcher(onUsers)

function sync(enabled: boolean): void {
  if (enabled) {
    previous = new Set()
    asked.clear()
    watcher.start()
  } else {
    watcher.stop()
    hidePrompt()
    current = null
  }
}

function answer(value: PromptAnswer): void {
  const name = current
  current = null
  hidePrompt()
  if (value === 'start') {
    toggleSession()
  } else if (value === 'ignore' && name) {
    const ignoredApps = [...getSettings().micPrompt.ignoredApps, name]
    void updateSettings({ micPrompt: { ...getSettings().micPrompt, ignoredApps } })
  }
  log('micprompt', 'answered', { answer: value, app: name ?? 'unknown' })
}

/** Offers to start a session when another app starts using the microphone. */
export function registerMicPrompt(): void {
  ipcMain.on('prompt:answer', (_event, value: unknown) => {
    const choice = ANSWERS.find((entry) => entry === value)
    if (choice) answer(choice)
  })
  sync(getSettings().micPrompt.enabled)
  onSettingsChanged((next, prev) => {
    if (next.micPrompt.enabled !== prev.micPrompt.enabled) sync(next.micPrompt.enabled)
  })
  // Our own recording is not a reason to ask.
  onSessionState((state) => {
    if (state.phase !== 'idle' && current !== null) {
      hidePrompt()
      current = null
    }
  })
}

export function stopMicPrompt(): void {
  watcher.stop()
}

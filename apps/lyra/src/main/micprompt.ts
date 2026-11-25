import { ipcMain } from 'electron'
import type { PromptAnswer } from '../shared/types'
import { log } from './log'
import { DETECTOR_DEFAULTS, MeetingDetector, type PromptTarget } from './meetingDetector'
import { MicWatcher, type AudioUsers } from './micwatch'
import { hidePrompt, showPrompt } from './overlay'
import { isRecording, onSessionState, sendSessionCommand } from './session'
import { getSettings, onSettingsChanged, updateSettings } from './settings'
import { windowTitles } from './windowTitles'

const ANSWERS: readonly PromptAnswer[] = ['start', 'dismiss', 'ignore']

const detector = new MeetingDetector({
  ...DETECTOR_DEFAULTS,
  now: Date.now,
  titles: windowTitles
})

let latest: AudioUsers = { mic: new Set(), playing: new Set() }
let current: PromptTarget | null = null
let busy = false
let recheck: ReturnType<typeof setTimeout> | null = null

function ignored(label: string): boolean {
  const name = label.toLowerCase()
  return getSettings().micPrompt.ignoredApps.some((entry) => entry.toLowerCase() === name)
}

function watching(): boolean {
  const settings = getSettings()
  return settings.meetingPrompt || settings.micPrompt.enabled
}

/** The macOS helper only reports changes, so look again once a new mic user has held on. */
function scheduleRecheck(): void {
  if (recheck) clearTimeout(recheck)
  recheck = null
  const due = detector.nextCheckAt()
  if (due === null || due <= Date.now()) return
  recheck = setTimeout(() => {
    recheck = null
    void onUsers(latest)
  }, due - Date.now() + 50)
}

async function onUsers(users: AudioUsers): Promise<void> {
  latest = users
  if (current !== null && !users.mic.has(current.user)) {
    hidePrompt()
    current = null
  }
  // A title read can outlast a poll; the next poll carries the newer state.
  if (busy) return
  busy = true
  try {
    const settings = getSettings()
    const target = await detector.update(users, {
      meetings: settings.meetingPrompt,
      anyApp: settings.micPrompt.enabled,
      recording: isRecording(),
      ignored
    })
    // Settings or recording may have changed while titles were read.
    if (target && watching() && !isRecording()) {
      current = target
      // App ids only: never window titles.
      log('micprompt', 'asking', {
        kind: target.kind,
        via: target.via,
        app: target.key || 'unknown'
      })
      showPrompt({ kind: target.kind, app: target.label })
    }
  } finally {
    busy = false
  }
  scheduleRecheck()
}

const watcher = new MicWatcher((users) => void onUsers(users))

function sync(enabled: boolean): void {
  if (enabled) {
    detector.reset()
    watcher.start()
  } else {
    watcher.stop()
    if (recheck) clearTimeout(recheck)
    recheck = null
    hidePrompt()
    current = null
  }
}

function answer(value: PromptAnswer): void {
  const target = current
  current = null
  hidePrompt()
  switch (value) {
    case 'start':
      // A meeting has other people in it, so it always records the computer's audio too.
      sendSessionCommand({ type: 'start', meeting: target?.kind === 'meeting' })
      break
    case 'dismiss':
      if (target) detector.snooze(target.key)
      break
    case 'ignore':
      if (target?.label) {
        const ignoredApps = [...getSettings().micPrompt.ignoredApps, target.label]
        void updateSettings({ micPrompt: { ...getSettings().micPrompt, ignoredApps } })
      }
      break
  }
  log('micprompt', 'answered', { answer: value, app: target?.key ?? 'unknown' })
}

/** Offers to start a session when a meeting (or, if asked for, any app) starts using the mic. */
export function registerMicPrompt(): void {
  ipcMain.on('prompt:answer', (_event, value: unknown) => {
    const choice = ANSWERS.find((entry) => entry === value)
    if (choice) answer(choice)
  })
  sync(watching())
  onSettingsChanged((next, prev) => {
    const was = prev.meetingPrompt || prev.micPrompt.enabled
    const now = next.meetingPrompt || next.micPrompt.enabled
    if (was !== now) sync(now)
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

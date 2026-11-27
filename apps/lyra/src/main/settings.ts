import { app, BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultLanguage } from '../shared/languages'
import { PANEL_WIDTHS, parseSettings, type Settings } from '../shared/settings'
import { writeFileAtomic } from './atomicFile'
import { config } from './config'
import { log } from './log'
import { readSettingsFile, settingsForDisk } from './settingsFile'

export function defaultSettings(): Settings {
  return {
    notesDir: config().notesDir ?? join(homedir(), '.lyra'),
    fileFormat: 'txt',
    micDeviceId: null,
    hotkey: 'CommandOrControl+Shift+Space',
    launchAtLogin: false,
    micPrompt: { enabled: false, ignoredApps: [] },
    // On: it only asks, never records, and runs on this computer (see meetingApps.ts).
    meetingPrompt: true,
    // Long enough to replay or re-transcribe recent sessions, short enough not to pile up.
    audioRetentionDays: 30,
    captureSystemAudio: true,
    transcriptionLanguage: defaultLanguage(app.getPreferredSystemLanguages()),
    // Empty: Whisper's prompt is then exactly what it was before the setting existed.
    vocabulary: [],
    notesEngine: 'off',
    cloudProvider: 'anthropic',
    cloudModel: null,
    cloudBaseUrl: null,
    meetingNoticeSeen: false,
    // Off until asked for: it downloads a model and works the CPU while it indexes.
    semanticSearch: false,
    // Off until asked for: a large download, and more work for the CPU after each session.
    largerSpeakerModel: false,
    sidebar: true,
    sidebarWidth: PANEL_WIDTHS.sidebar.initial
  }
}

type Listener = (next: Settings, prev: Settings) => void

let current: Settings | null = null
/**
 * The file as read. Keys this build doesn't know (from a newer Lyra) are written back with it,
 * so running an older build doesn't strip them.
 */
let stored: Record<string, unknown> = {}
const listeners = new Set<Listener>()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (current) return current
  const read = readSettingsFile(settingsPath())
  switch (read.kind) {
    case 'missing':
      break
    case 'ok':
      stored = read.raw
      break
    case 'corrupt':
      // Kept, so a hand edit with a typo can be fixed rather than lost to the defaults.
      log('settings', 'settings file was unreadable; using defaults', {
        reason: read.reason,
        aside: read.aside
      })
      break
  }
  current = parseSettings(stored, defaultSettings())
  return current
}

/** Writes in call order: overlapping updates never interleave or land out of order. */
let writing: Promise<void> = Promise.resolve()

function persist(settings: Settings): Promise<void> {
  const path = settingsPath()
  const run = writing.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, JSON.stringify(settingsForDisk(stored, settings), null, 2))
  })
  writing = run.catch(() => undefined)
  return run
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const prev = getSettings()
  const merged = { ...prev, ...patch, micPrompt: { ...prev.micPrompt, ...(patch.micPrompt ?? {}) } }
  const next = parseSettings(merged, prev)
  current = next
  await persist(next)
  log('settings', 'updated', Object.keys(patch))
  for (const listener of listeners) listener(next, prev)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('settings:changed', next)
  return next
}

/** Overrides settings in memory only (smoke tests). */
export function overrideSettings(patch: Partial<Settings>): void {
  current = parseSettings({ ...getSettings(), ...patch }, getSettings())
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

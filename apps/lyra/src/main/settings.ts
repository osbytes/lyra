import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultLanguage } from '../shared/languages'
import { PANEL_WIDTHS, parseSettings, type Settings } from '../shared/settings'
import { config } from './config'
import { log } from './log'

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
    notesEngine: 'off',
    cloudProvider: 'anthropic',
    cloudModel: null,
    cloudBaseUrl: null,
    meetingNoticeSeen: false,
    // Off until asked for: it downloads a model and works the CPU while it indexes.
    semanticSearch: false,
    detailsPanel: false,
    sidebar: true,
    sidebarWidth: PANEL_WIDTHS.sidebar.initial,
    detailsWidth: PANEL_WIDTHS.details.initial
  }
}

type Listener = (next: Settings, prev: Settings) => void

let current: Settings | null = null
const listeners = new Set<Listener>()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (current) return current
  let stored: unknown = null
  try {
    stored = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    // Missing or unreadable: start from defaults.
  }
  current = parseSettings(stored, defaultSettings())
  return current
}

async function persist(settings: Settings): Promise<void> {
  const path = settingsPath()
  const temp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8')
  await rename(temp, path)
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

import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Settings } from '../shared/types'
import { log } from './log'

export function defaultSettings(): Settings {
  return {
    notesDir: join(homedir(), '.lyra'),
    fileFormat: 'txt',
    micDeviceId: null,
    hotkey: 'CommandOrControl+Shift+Space',
    meetingHotkey: 'CommandOrControl+Shift+M',
    launchAtLogin: false,
    micPrompt: { enabled: false, ignoredApps: [] },
    keepMeetingAudio: false,
    captureSystemAudio: true,
    notesEngine: 'off',
    meetingNoticeSeen: false
  }
}

type Listener = (next: Settings, prev: Settings) => void

let current: Settings | null = null
const listeners = new Set<Listener>()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isBool = (value: unknown): value is boolean => typeof value === 'boolean'

const oneOf =
  <T extends string>(...values: T[]) =>
  (value: unknown): value is T =>
    values.includes(value as T)

type FlatKey = Exclude<keyof Settings, 'micPrompt'>

/** How to recognize a well-formed value for each top-level setting. */
const FIELD_CHECKS: { [K in FlatKey]: (value: unknown) => value is Settings[K] } = {
  notesDir: (value): value is string => isString(value) && !!value.trim() && isAbsolute(value),
  fileFormat: oneOf('txt', 'md'),
  micDeviceId: (value): value is string | null => value === null || isString(value),
  hotkey: isString,
  meetingHotkey: isString,
  launchAtLogin: isBool,
  keepMeetingAudio: isBool,
  captureSystemAudio: isBool,
  notesEngine: oneOf('off', 'local', 'claude'),
  meetingNoticeSeen: isBool
}

/** Copies every well-formed field of `raw` onto `out`; anything else is ignored. */
function applyValidFields(raw: Record<string, unknown>, out: Settings): void {
  for (const key of Object.keys(FIELD_CHECKS) as FlatKey[]) {
    const value = raw[key]
    if (FIELD_CHECKS[key](value)) (out as Record<FlatKey, unknown>)[key] = value
  }

  const prompt = raw.micPrompt as Record<string, unknown> | undefined
  if (prompt && typeof prompt === 'object') {
    if (isBool(prompt.enabled)) out.micPrompt.enabled = prompt.enabled
    if (Array.isArray(prompt.ignoredApps)) {
      out.micPrompt.ignoredApps = prompt.ignoredApps.filter(isString)
    }
  }
}

/** Keeps only well-formed fields from `input`, layered over `base`. */
function sanitize(input: unknown, base: Settings): Settings {
  const out: Settings = { ...base, micPrompt: { ...base.micPrompt } }
  if (input && typeof input === 'object') applyValidFields(input as Record<string, unknown>, out)
  return out
}

export function getSettings(): Settings {
  if (current) return current
  let stored: unknown = null
  try {
    stored = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    // Missing or unreadable: start from defaults.
  }
  current = sanitize(stored, defaultSettings())
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
  const next = sanitize(merged, prev)
  current = next
  await persist(next)
  log('settings', 'updated', Object.keys(patch))
  for (const listener of listeners) listener(next, prev)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('settings:changed', next)
  return next
}

/** Overrides settings in memory only (smoke tests). */
export function overrideSettings(patch: Partial<Settings>): void {
  current = sanitize({ ...getSettings(), ...patch }, getSettings())
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

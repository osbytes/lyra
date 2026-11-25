import { copyFileSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { asideStamp } from './atomicFile'

/** Reading and writing `settings.json`. Pure (no Electron), so the rules can be unit-tested. */

export type SettingsFileRead =
  | { kind: 'missing' }
  | { kind: 'ok'; raw: Record<string, unknown> }
  /** `aside` is where the unreadable file was copied, or null if it couldn't be. */
  | { kind: 'corrupt'; reason: string; aside: string | null }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `settings.json` → `settings.corrupt-<time>.json`, beside it. */
export function corruptCopyPath(path: string, date: Date = new Date()): string {
  const ext = extname(path)
  return join(dirname(path), `${basename(path, ext)}.corrupt-${asideStamp(date)}${ext}`)
}

function copyAside(path: string): string | null {
  const aside = corruptCopyPath(path)
  try {
    copyFileSync(path, aside)
    return aside
  } catch {
    return null
  }
}

/**
 * Reads the settings file. An unreadable one is copied aside before the caller falls back to
 * defaults, since the next save would otherwise replace it.
 */
export function readSettingsFile(path: string): SettingsFileRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', reason: 'unreadable', aside: copyAside(path) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'corrupt', reason: 'not JSON', aside: copyAside(path) }
  }
  if (!isRecord(parsed)) return { kind: 'corrupt', reason: 'not an object', aside: copyAside(path) }
  return { kind: 'ok', raw: parsed }
}

/** The settings over what the file held, so keys a newer Lyra wrote survive this one saving. */
export function settingsForDisk(stored: Record<string, unknown>, settings: object): Record<string, unknown> {
  return { ...stored, ...settings }
}

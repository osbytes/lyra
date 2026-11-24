import { app, safeStorage } from 'electron'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeKeySource } from '../shared/types'
import { config } from './config'
import { log } from './log'

/**
 * The Claude API key, encrypted with the OS keychain (Electron safeStorage), or ANTHROPIC_API_KEY
 * when none is saved. Never written to settings.json or logged. Having a key never sends anything:
 * summaries go to Claude only when the user picks Claude in Settings.
 */

function secretPath(): string {
  return join(app.getPath('userData'), 'claude-key.bin')
}

async function keychainKey(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(await readFile(secretPath()))
  } catch {
    return null
  }
}

/** A key saved in Settings wins over the environment. */
export async function getClaudeKey(): Promise<string | null> {
  return (await keychainKey()) ?? config().anthropicApiKey
}

export async function claudeKeySource(): Promise<ClaudeKeySource | null> {
  if ((await keychainKey()) !== null) return 'keychain'
  return config().anthropicApiKey === null ? null : 'environment'
}

export async function setClaudeKey(key: string | null): Promise<void> {
  const path = secretPath()
  const trimmed = key?.trim() ?? ''
  if (!trimmed) {
    await unlink(path).catch(() => undefined)
    log('secrets', 'Claude key removed')
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system')
  }
  await writeFile(`${path}.tmp`, safeStorage.encryptString(trimmed))
  await rename(`${path}.tmp`, path)
  log('secrets', 'Claude key saved')
}

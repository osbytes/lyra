import { app, safeStorage } from 'electron'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'

/**
 * The Claude API key, encrypted with the OS keychain (Electron safeStorage).
 * Never written to settings.json or logged.
 */

function secretPath(): string {
  return join(app.getPath('userData'), 'claude-key.bin')
}

export async function getClaudeKey(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(await readFile(secretPath()))
  } catch {
    return null
  }
}

export async function hasClaudeKey(): Promise<boolean> {
  return (await getClaudeKey()) !== null
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

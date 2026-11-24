import { app, ipcMain, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ProviderId, type KeySource } from '../shared/ai'
import { config } from './config'
import { log } from './log'

/**
 * API keys for cloud model providers, one per provider, encrypted with the OS keychain (Electron
 * safeStorage), or the provider's standard environment variable when none is saved. Never written
 * to settings.json or logged. Having a key never sends anything: summaries use a cloud model only
 * when the user picks one in Settings.
 */

function keyPath(provider: ProviderId): string {
  return join(app.getPath('userData'), 'keys', `${provider}.bin`)
}

/** Lyra 0.3 kept its one key, for Claude, here. Still read; removed when the key changes. */
function legacyPath(provider: ProviderId): string | null {
  return provider === 'anthropic' ? join(app.getPath('userData'), 'claude-key.bin') : null
}

async function decrypt(path: string): Promise<string | null> {
  try {
    return safeStorage.decryptString(await readFile(path))
  } catch {
    return null
  }
}

async function keychainKey(provider: ProviderId): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  const legacy = legacyPath(provider)
  return (await decrypt(keyPath(provider))) ?? (legacy === null ? null : await decrypt(legacy))
}

/** A key saved in Settings wins over the environment. */
export async function getApiKey(provider: ProviderId): Promise<string | null> {
  return (await keychainKey(provider)) ?? config().apiKeys[provider]
}

export async function keySource(provider: ProviderId): Promise<KeySource | null> {
  if ((await keychainKey(provider)) !== null) return 'keychain'
  return config().apiKeys[provider] === null ? null : 'environment'
}

/** Saves `key` for `provider`; null or blank removes the saved key. */
export async function setApiKey(provider: ProviderId, key: string | null): Promise<void> {
  const path = keyPath(provider)
  const legacy = legacyPath(provider)
  if (legacy !== null) await unlink(legacy).catch(() => undefined)
  const trimmed = key?.trim() ?? ''
  if (!trimmed) {
    await unlink(path).catch(() => undefined)
    log('secrets', 'key removed', { provider })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system')
  }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(`${path}.tmp`, safeStorage.encryptString(trimmed))
  await rename(`${path}.tmp`, path)
  log('secrets', 'key saved', { provider })
}

/** The renderer asks where a provider's key comes from, and saves or removes it. */
export function registerKeyIpc(): void {
  ipcMain.handle('secrets:keySource', (_event, provider: unknown) => keySource(ProviderId.parse(provider)))
  ipcMain.handle('secrets:setKey', (_event, provider: unknown, key: unknown) =>
    setApiKey(ProviderId.parse(provider), z.string().nullable().parse(key))
  )
}

import { app, ipcMain, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PROVIDERS, ProviderId, type KeySource } from '../shared/ai'
import { config } from './config'
import { log } from './log'
import { isFromMainWindow } from './session'

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

/**
 * Why a key can't be saved here, or null when it can. On Linux without a keyring (GNOME Keyring,
 * KWallet) Electron falls back to its `basic_text` backend, which only obscures the key with a
 * fixed password: as good as plain text, so Lyra refuses rather than pretend it is encrypted.
 */
function cannotStoreKeys(provider: ProviderId): string | null {
  const instead = PROVIDERS[provider].keyEnv
  const useEnv = instead ? ` Set ${instead} in the environment instead.` : ''
  if (!safeStorage.isEncryptionAvailable()) {
    return `Secure storage is not available on this system.${useEnv}`
  }
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') {
      log('secrets', 'no keyring; refusing to store a key', { backend })
      return `No system keyring (such as GNOME Keyring or KWallet) is available, so the key would be stored unencrypted.${useEnv}`
    }
  }
  return null
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
  const problem = cannotStoreKeys(provider)
  if (problem) throw new Error(problem)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(`${path}.tmp`, safeStorage.encryptString(trimmed))
  await rename(`${path}.tmp`, path)
  log('secrets', 'key saved', { provider })
}

/** A pasted API key; anything longer is not a key. */
const KeyArg = z.string().max(4096).nullable()

/** The renderer asks where a provider's key comes from, and saves or removes it. */
export function registerKeyIpc(): void {
  ipcMain.handle('secrets:keySource', (event, provider: unknown) => {
    if (!isFromMainWindow(event)) throw new Error('Not allowed from this window')
    return keySource(ProviderId.parse(provider))
  })
  ipcMain.handle('secrets:setKey', (event, provider: unknown, key: unknown) => {
    if (!isFromMainWindow(event)) throw new Error('Not allowed from this window')
    return setApiKey(ProviderId.parse(provider), KeyArg.parse(key))
  })
}

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { config, hubUrl } from './config'
import { log } from './log'

/**
 * Where downloaded model files live: `userData/models`, or LYRA_MODELS_DIR, which smoke tests and
 * evals set to reuse one download across throwaway profiles.
 */
export function modelsDir(): string {
  return config().modelsDir ?? join(app.getPath('userData'), 'models')
}

/**
 * A model file pinned to one upstream revision. `url` names a commit or release, never a moving
 * branch, and the download must match `bytes` and `sha256` exactly, so every install and every
 * eval runs the same weights.
 */
export type ModelFile = {
  name: string
  url: string
  bytes: number
  sha256: string
}

export type DownloadProgress = (received: number, total: number) => void

const inFlight = new Map<string, Promise<string>>()

/** A sidecar holding the verified hash, so a file is hashed once rather than on every start. */
function verifiedMarker(path: string): string {
  return `${path}.sha256`
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk: Buffer | string) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(hash.digest('hex'))
      })
  })
}

/** True when `path` is this exact model file, hashing it once if it predates verification. */
async function isVerified(path: string, model: ModelFile): Promise<boolean> {
  if ((await sizeOf(path)) !== model.bytes) return false
  const marker = await readFile(verifiedMarker(path), 'utf8').catch(() => null)
  if (marker?.trim() === model.sha256) return true
  if ((await hashFile(path)) !== model.sha256) return false
  await writeFile(verifiedMarker(path), model.sha256)
  return true
}

async function download(model: ModelFile, dest: string, onProgress?: DownloadProgress): Promise<void> {
  const temp = `${dest}.part`
  const url = hubUrl(model.url)
  try {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${String(response.status)}) for ${url}`)
    }
    let received = 0
    onProgress?.(received, model.bytes)

    const hash = createHash('sha256')
    const file = createWriteStream(temp)
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      hash.update(value)
      onProgress?.(received, model.bytes)
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once('drain', resolve))
      }
    }
    file.end()
    await finished(file)

    const digest = hash.digest('hex')
    if (received !== model.bytes || digest !== model.sha256) {
      throw new Error(
        `Downloaded ${model.name} does not match its pinned hash (got ${String(received)} bytes, sha256 ${digest})`
      )
    }
    await rename(temp, dest)
    await writeFile(verifiedMarker(dest), model.sha256)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** True when `model` is already downloaded and matches its pinned size. Cheap: no hashing. */
export async function hasModelFile(model: ModelFile): Promise<boolean> {
  return (await sizeOf(join(modelsDir(), model.name))) === model.bytes
}

/**
 * Returns the path of `model`, downloading it first unless a verified copy is already there. A
 * copy that fails verification (a partial file, an older revision) is replaced. Concurrent calls
 * share one download.
 */
export function ensureModelFile(model: ModelFile, onProgress?: DownloadProgress): Promise<string> {
  const existing = inFlight.get(model.name)
  if (existing) return existing
  const dest = join(modelsDir(), model.name)
  const task = (async () => {
    if (await isVerified(dest, model)) return dest
    await mkdir(modelsDir(), { recursive: true })
    log('models', 'downloading', { name: model.name, url: hubUrl(model.url) })
    await download(model, dest, onProgress)
    log('models', 'downloaded', { name: model.name })
    return dest
  })().finally(() => inFlight.delete(model.name))
  inFlight.set(model.name, task)
  return task
}

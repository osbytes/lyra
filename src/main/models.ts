import { app } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { log } from './log'

/** Where downloaded model files live: `userData/models`. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export type DownloadProgress = (received: number, total: number) => void

const inFlight = new Map<string, Promise<string>>()

async function hasFile(path: string, minBytes: number): Promise<boolean> {
  try {
    return (await stat(path)).size >= minBytes
  } catch {
    return false
  }
}

async function download(url: string, dest: string, onProgress?: DownloadProgress): Promise<void> {
  const temp = `${dest}.part`
  try {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status}) for ${url}`)
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    onProgress?.(received, total)

    const file = createWriteStream(temp)
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress?.(received, total)
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once('drain', resolve))
      }
    }
    file.end()
    await finished(file)
    await rename(temp, dest)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * Returns the path of model `name`, downloading it from `url` first if it's
 * missing or smaller than `minBytes`. Concurrent calls share one download.
 */
export function ensureDownload(
  name: string,
  url: string,
  minBytes: number,
  onProgress?: DownloadProgress
): Promise<string> {
  const existing = inFlight.get(name)
  if (existing) return existing
  const dest = join(modelsDir(), name)
  const task = (async () => {
    if (await hasFile(dest, minBytes)) return dest
    await mkdir(modelsDir(), { recursive: true })
    log('models', 'downloading', { name, url })
    await download(url, dest, onProgress)
    log('models', 'downloaded', { name })
    return dest
  })().finally(() => inFlight.delete(name))
  inFlight.set(name, task)
  return task
}

import { app, net } from 'electron'
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { config, hubUrl } from './config'
import { backoffMs, MAX_RETRIES, megabytes, planResponse, progressThrottle, spaceShortfall } from './downloadPlan'
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

/** No bytes for this long and the connection is dropped and tried again. */
const STALL_MS = 30_000
/** Progress reports at most five times a second. */
const PROGRESS_MS = 200

/** A failure retrying won't fix: the file is wrong, the disk is full, or the user cancelled. */
class FatalDownloadError extends Error {}
/** The `.part` file holds the wrong bytes: it is deleted, never resumed. */
class CorruptPartError extends FatalDownloadError {}

/** The attempt in progress for each model, so it can be cancelled. */
const downloads = new Map<string, { controller: AbortController; cancelled: boolean }>()

/** Stops the download of `name` if one is running, keeping what arrived for next time. */
export function cancelModelDownload(name: string): boolean {
  const download = downloads.get(name)
  if (!download) return false
  download.cancelled = true
  download.controller.abort()
  return true
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Electron's `net.fetch` in the main process: Chromium's network stack, so the system proxy and
 * PAC settings apply as they do in a browser (Node's fetch ignores them). Anywhere else (before
 * the app is ready, a plain Node script) the global fetch.
 */
function fetcher(): Fetch {
  if (process.type === 'browser' && app.isReady()) return (url, init) => net.fetch(url, init)
  return (url, init) => fetch(url, init)
}

function hashPrefix(path: string, bytes: number, hash: Hash): Promise<void> {
  if (bytes === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    createReadStream(path, { start: 0, end: bytes - 1 })
      .on('data', (chunk: Buffer | string) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
}

async function ensureSpace(dir: string, model: ModelFile, needed: number): Promise<void> {
  const stats = await statfs(dir).catch(() => null)
  // Not every file system reports free space; then the write itself will say.
  if (!stats) return
  const free = stats.bavail * stats.bsize
  if (spaceShortfall(free, needed) > 0) {
    throw new FatalDownloadError(
      `Not enough disk space to download ${model.name}: it needs ${megabytes(needed)}, ` +
        `${megabytes(free)} free in ${dir}`
    )
  }
}

/**
 * One request for the rest of the file, continuing `.part` when the server can (HTTP Range).
 * Resolves with the bytes and hash of the finished part; network trouble rejects with the part
 * kept, so the next attempt picks up where this one stopped.
 */
async function fetchRest(
  model: ModelFile,
  url: string,
  temp: string,
  attempt: { controller: AbortController },
  report: (received: number, force?: boolean) => void
): Promise<{ received: number; digest: string; resumedFrom: number }> {
  let offset = (await sizeOf(temp)) ?? 0
  if (offset > model.bytes) {
    await unlink(temp)
    offset = 0
  }
  const hash = createHash('sha256')
  if (offset === model.bytes) {
    await hashPrefix(temp, offset, hash)
    return { received: offset, digest: hash.digest('hex'), resumedFrom: offset }
  }
  const { controller } = attempt
  let stall: ReturnType<typeof setTimeout> | undefined
  const armStall = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => {
      controller.abort()
    }, STALL_MS)
  }
  armStall()
  try {
    const response = await fetcher()(url, {
      headers: offset > 0 ? { Range: `bytes=${String(offset)}-` } : {},
      signal: controller.signal
    })
    const plan = planResponse(response.status, response.headers.get('content-range'), offset, model.bytes)
    switch (plan.action) {
      case 'append':
        break
      case 'restart':
        offset = 0
        break
      case 'discard':
        await response.body?.cancel()
        await unlink(temp).catch(() => undefined)
        throw new Error(`The server can't continue ${model.name} from ${String(offset)} bytes; starting over`)
      case 'retry':
        await response.body?.cancel()
        throw new Error(`Download failed (${plan.reason}) for ${url}`)
      case 'fail':
        await response.body?.cancel()
        throw new FatalDownloadError(`Download failed (${plan.reason}) for ${url}`)
    }
    if (!response.body) throw new Error(`Download returned no data for ${url}`)
    if (offset > 0) {
      await hashPrefix(temp, offset, hash)
      log('models', 'resuming', { name: model.name, from: offset })
      // Hashing a large part takes seconds; that's not the connection stalling.
      armStall()
    }
    let received = offset
    report(received, true)
    const file = createWriteStream(temp, { flags: offset > 0 ? 'a' : 'w' })
    const failed = new Promise<never>((_resolve, reject) => {
      file.once('error', reject)
    })
    failed.catch(() => undefined)
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armStall()
        received += value.byteLength
        if (received > model.bytes) {
          await reader.cancel()
          throw new CorruptPartError(`Downloaded ${model.name} is larger than its pinned size`)
        }
        hash.update(value)
        report(received)
        if (!file.write(Buffer.from(value))) {
          await Promise.race([new Promise<void>((resolve) => file.once('drain', resolve)), failed])
        }
      }
    } finally {
      file.end()
      await Promise.race([finished(file), failed])
    }
    if (received < model.bytes) throw new Error(`Download of ${model.name} ended early at ${String(received)} bytes`)
    return { received, digest: hash.digest('hex'), resumedFrom: offset }
  } finally {
    clearTimeout(stall)
  }
}

function isDiskFull(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOSPC' || error.code === 'EDQUOT')
}

async function download(model: ModelFile, dest: string, onProgress?: DownloadProgress): Promise<void> {
  const temp = `${dest}.part`
  const url = hubUrl(model.url)
  const throttle = progressThrottle(PROGRESS_MS)
  const report = (received: number, force = false): void => {
    if (throttle(force || received === model.bytes)) onProgress?.(received, model.bytes)
  }
  await ensureSpace(dirname(dest), model, model.bytes - ((await sizeOf(temp)) ?? 0))
  const attempt = { controller: new AbortController(), cancelled: false }
  downloads.set(model.name, attempt)
  // A part left by an earlier run may hold bytes of another revision; it gets one clean restart.
  let restarted = false
  try {
    for (let tries = 0; ; tries++) {
      attempt.controller = new AbortController()
      try {
        const { received, digest, resumedFrom } = await fetchRest(model, url, temp, attempt, report)
        report(received, true)
        if (received !== model.bytes || digest !== model.sha256) {
          await unlink(temp).catch(() => undefined)
          if (resumedFrom > 0 && !restarted) {
            restarted = true
            log('models', 'resumed download did not match, starting over', { name: model.name, resumedFrom })
            continue
          }
          throw new FatalDownloadError(
            `Downloaded ${model.name} does not match its pinned hash (got ${String(received)} bytes, sha256 ${digest})`
          )
        }
        break
      } catch (error) {
        if (attempt.cancelled) throw new Error(`Download of ${model.name} was cancelled`, { cause: error })
        if (error instanceof CorruptPartError) await unlink(temp).catch(() => undefined)
        if (error instanceof FatalDownloadError) throw error
        if (isDiskFull(error)) {
          throw new Error(`The disk is full; ${model.name} could not be downloaded`, { cause: error })
        }
        if (tries >= MAX_RETRIES) throw error
        const wait = backoffMs(tries)
        log('models', 'download interrupted, retrying', {
          name: model.name,
          error: error instanceof Error ? error.message : String(error),
          kept: (await sizeOf(temp)) ?? 0,
          waitMs: wait
        })
        // Cancelling during the pause ends it at once rather than after the wait.
        await sleep(wait, undefined, { signal: attempt.controller.signal }).catch((abort: unknown) => {
          throw new Error(`Download of ${model.name} was cancelled`, { cause: abort })
        })
      }
    }
  } finally {
    downloads.delete(model.name)
  }
  await rename(temp, dest)
  await writeFile(verifiedMarker(dest), model.sha256)
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
    // A model made of several files keeps them in a folder of its own (`name` is then a path).
    await mkdir(dirname(dest), { recursive: true })
    log('models', 'downloading', { name: model.name, url: hubUrl(model.url) })
    await download(model, dest, onProgress)
    log('models', 'downloaded', { name: model.name })
    return dest
  })().finally(() => inFlight.delete(model.name))
  inFlight.set(model.name, task)
  return task
}

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import { ensureModelFile, hasModelFile, type DownloadProgress, type ModelFile } from '../models'
import { downloadReporter, reportModelFailure, setModelStatus } from '../modelStatus'
import { cleanTitle, MeetingNotes, PACKAGED_FLAG, tidyNotes, TitleSuggestion } from './notesFormat'
import { NotesWorkerResponse, type NotesWorkerRequest } from './notesProtocol'
import type { NotesWriter } from './notesWriter'

const MODEL: ModelFile = {
  name: 'qwen2.5-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/7dabda4d13d513e3e842b20f0d435c732f172cbe/qwen2.5-3b-instruct-q4_k_m.gguf',
  bytes: 2_104_932_768,
  sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d'
}

/** The model's path, downloading it first if needed; Settings sees how it goes. */
async function fetchModel(onDownload?: DownloadProgress): Promise<string> {
  const report = downloadReporter('localNotes', MODEL)
  try {
    const path = await ensureModelFile(MODEL, (received, total) => {
      report(received, total)
      onDownload?.(received, total)
    })
    setModelStatus({ feature: 'localNotes', model: MODEL.name, state: 'ready' })
    return path
  } catch (error) {
    reportModelFailure('localNotes', MODEL, error)
    throw error
  }
}

/**
 * Starts the ~2 GB download in the background when local summaries are picked, so the first
 * summary doesn't wait for it. A failure shows in Settings (with Retry) and is logged.
 */
export function prefetchNotesModel(): void {
  fetchModel().catch((error: unknown) => {
    log('notes', 'could not download the local model', { error: error instanceof Error ? error.message : String(error) })
  })
}

/** Tells Settings whether the model is already here, without downloading or hashing it. */
export async function reportNotesModel(): Promise<void> {
  const present = await hasModelFile(MODEL)
  setModelStatus({ feature: 'localNotes', model: MODEL.name, state: present ? 'ready' : 'missing' })
}

let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function getWorker(): UtilityProcess {
  if (worker) return worker
  // The worker can't ask `app` whether this is a packaged build, so it's told on its command line.
  const child = utilityProcess.fork(join(__dirname, 'notesWorker.js'), app.isPackaged ? [PACKAGED_FLAG] : [], {
    serviceName: 'Lyra notes worker'
  })
  child.on('message', (data: unknown) => {
    const parsed = NotesWorkerResponse.safeParse(data)
    if (!parsed.success) return
    const message = parsed.data
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  })
  child.on('exit', (code) => {
    log('notes', 'local worker exited', { code })
    if (worker === child) worker = null
    for (const entry of pending.values()) entry.reject(new Error('Notes worker stopped'))
    pending.clear()
  })
  worker = child
  return child
}

type Work = { kind: 'notes'; modelPath: string; transcript: string } | { kind: 'title'; modelPath: string; text: string }

/** Sends one request to the worker; aborting `signal` stops it there too. */
function ask(work: Work, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const id = nextId++
  const child = getWorker()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      if (!pending.delete(id)) return
      const cancel: NotesWorkerRequest = { kind: 'cancel', id }
      child.postMessage(cancel)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
    const request: NotesWorkerRequest = { ...work, id }
    child.postMessage(request)
  })
}

/**
 * The NotesWriter for the on-device model (~2 GB, downloaded on first use); it never sends
 * anything off this computer. The worker splits a long meeting to fit the model's context,
 * measured with its own tokenizer, and merges the partial notes.
 */
export function createLocalNotesWriter(): NotesWriter {
  return {
    name: 'local',
    onDevice: true,
    async notes(transcript, { onDownload, signal } = {}) {
      const modelPath = await fetchModel(onDownload)
      // The grammar makes the model emit this shape; parsing is the check, not a hope.
      return tidyNotes(MeetingNotes.parse(await ask({ kind: 'notes', modelPath, transcript }, signal)))
    },
    async title(text, signal) {
      const modelPath = await ensureModelFile(MODEL)
      const answer = await ask({ kind: 'title', modelPath, text }, signal)
      const parsed = TitleSuggestion.safeParse(answer)
      return parsed.success ? cleanTitle(parsed.data.title) : null
    },
    // A title alone never starts the ~2 GB download.
    canTitle: () => hasModelFile(MODEL)
  }
}

/**
 * Frees the local model's memory as soon as the work already asked for is done (the worker also
 * does this on its own after a few idle minutes). Call when a recording starts, so Whisper has
 * the room. Does nothing when the worker isn't running.
 */
export function releaseNotesModel(): void {
  if (!worker) return
  const release: NotesWorkerRequest = { kind: 'release' }
  worker.postMessage(release)
}

export function stopNotesWorker(): void {
  worker?.kill()
  worker = null
}

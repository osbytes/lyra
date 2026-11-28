import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import { ensureModelFile, hasModelFile, type DownloadProgress, type ModelFile } from '../models'
import { downloadReporter, reportModelFailure, setModelStatus } from '../modelStatus'
import {
  cleanTitle,
  PACKAGED_FLAG,
  SpeakersFound,
  TitleSuggestion,
  WrittenNotes,
  type NotesLine
} from './notesFormat'
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
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: ((done: number, total: number) => void) | undefined
  onAnswer?: ((key: string, answer: unknown) => void) | undefined
}
const pending = new Map<number, Pending>()

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
    switch (message.kind) {
      case 'progress':
        entry.onProgress?.(message.done, message.total)
        return
      case 'answer':
        entry.onAnswer?.(message.key, message.answer)
        return
      case 'result':
        pending.delete(message.id)
        entry.resolve(message.result)
        return
      case 'error':
        pending.delete(message.id)
        entry.reject(new Error(message.error))
        return
    }
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

type Work =
  | { kind: 'notes'; modelPath: string; lines: NotesLine[]; known: Readonly<Record<string, unknown>> }
  | { kind: 'title' | 'speakers'; modelPath: string; text: string }
type Hooks = Pick<Pending, 'onProgress' | 'onAnswer'>

/** Sends one request to the worker; aborting `signal` stops it there too. */
function ask(work: Work, signal?: AbortSignal, hooks: Hooks = {}): Promise<unknown> {
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
      ...hooks,
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
 * anything off this computer. The worker cuts a long meeting into sections that fit the model's
 * context, measured with its own tokenizer (notesPipeline.ts).
 */
export function createLocalNotesWriter(): NotesWriter {
  return {
    name: 'local',
    onDevice: true,
    async notes(lines, { onDownload, signal, onProgress, answers } = {}) {
      const modelPath = await fetchModel(onDownload)
      const work: Work = { kind: 'notes', modelPath, lines, known: answers?.known ?? {} }
      // The worker's pipeline already tidied the notes; this checks what crossed the boundary.
      return WrittenNotes.parse(await ask(work, signal, { onProgress, onAnswer: answers?.save }))
    },
    async title(text, signal) {
      const modelPath = await ensureModelFile(MODEL)
      const answer = await ask({ kind: 'title', modelPath, text }, signal)
      const parsed = TitleSuggestion.safeParse(answer)
      return parsed.success ? cleanTitle(parsed.data.title) : null
    },
    async speakers(transcript, signal) {
      const modelPath = await ensureModelFile(MODEL)
      // The grammar shapes the answer; this checks what crossed the process boundary.
      const parsed = SpeakersFound.safeParse(await ask({ kind: 'speakers', modelPath, text: transcript }, signal))
      return parsed.success ? parsed.data : { speakers: [] }
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

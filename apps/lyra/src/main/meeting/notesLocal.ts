import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import { ensureModelFile, hasModelFile, type DownloadProgress, type ModelFile } from '../models'
import {
  chunkTranscript,
  cleanTitle,
  MeetingNotes,
  PACKAGED_FLAG,
  tidyNotes,
  TitleSuggestion
} from './notesFormat'
import type { NotesWriter } from './notesWriter'
import type { NotesWorkerRequest, NotesWorkerResponse } from './notesWorker'

const MODEL: ModelFile = {
  name: 'qwen2.5-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/7dabda4d13d513e3e842b20f0d435c732f172cbe/qwen2.5-3b-instruct-q4_k_m.gguf',
  bytes: 2_104_932_768,
  sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d'
}

/** ~6k tokens of transcript per pass leaves room for the prompt and the answer in 8k. */
const CHUNK_CHARS = 20_000

let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown[]) => void; reject: (error: Error) => void }>()

function getWorker(): UtilityProcess {
  if (worker) return worker
  // The worker can't ask `app` whether this is a packaged build, so it's told on its command line.
  const child = utilityProcess.fork(join(__dirname, 'notesWorker.js'), app.isPackaged ? [PACKAGED_FLAG] : [], {
    serviceName: 'Lyra notes worker'
  })
  child.on('message', (message: NotesWorkerResponse) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.results)
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

function ask(modelPath: string, prompts: string[], task: NotesWorkerRequest['task'] = 'notes'): Promise<unknown[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const request: NotesWorkerRequest = { id, modelPath, prompts, task }
    getWorker().postMessage(request)
  })
}

/**
 * Meeting notes from a local model (~2 GB, downloaded on first use). Long meetings are
 * summarized in parts, then the partial notes are merged.
 */
async function localNotes(transcript: string, onDownload?: DownloadProgress): Promise<MeetingNotes> {
  const modelPath = await ensureModelFile(MODEL, onDownload)
  const chunks = chunkTranscript(transcript, CHUNK_CHARS)
  const answers = await ask(
    modelPath,
    chunks.map((chunk, i) =>
      chunks.length > 1
        ? `Transcript, part ${String(i + 1)} of ${String(chunks.length)}:\n\n${chunk}`
        : `Transcript:\n\n${chunk}`
    )
  )
  // The grammar makes the model emit this shape; parsing is the check, not a hope.
  const partials = answers.map((answer) => MeetingNotes.parse(answer))
  const [only] = partials
  if (partials.length === 1 && only) return tidyNotes(only)
  const [merged] = await ask(modelPath, [
    'Merge these partial meeting notes (JSON, one per part of the meeting, in order) into one ' +
      'set of notes. Remove duplicates.\n\n' +
      JSON.stringify(partials)
  ])
  return tidyNotes(MeetingNotes.parse(merged))
}

/** The NotesWriter for the on-device model; it never sends anything off this computer. */
export function createLocalNotesWriter(): NotesWriter {
  return {
    name: 'local',
    notes: localNotes,
    async title(text) {
      const modelPath = await ensureModelFile(MODEL)
      const [answer] = await ask(modelPath, [`Note:\n\n${text}`], 'title')
      const parsed = TitleSuggestion.safeParse(answer)
      return parsed.success ? cleanTitle(parsed.data.title) : null
    },
    // A title alone never starts the ~2 GB download.
    canTitle: () => hasModelFile(MODEL)
  }
}

export function stopNotesWorker(): void {
  worker?.kill()
  worker = null
}

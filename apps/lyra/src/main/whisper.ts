import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import type { TranscriptWord, WhisperStatus } from '../shared/types'
import { log } from './log'
import { getSettings } from './settings'
import { ensureSpeechVad } from './speechVad'
import { ensureModelFile, hasModelFile, modelsDir, type ModelFile } from './models'
import { isHallucination, wordsFromTokens } from './whisperText'
import { withVocabulary } from '../shared/vocabulary'

/**
 * Whisper large-v3-turbo, 5-bit. Recordings are transcribed in whole chunks at pauses rather than
 * streamed, so the model can be far larger than base.en: it transcribes 30 s of audio in well
 * under a second on a desktop GPU, and is much more accurate on real meetings. The addon keeps
 * the first model it loads, so every caller uses this one.
 */
const MODEL: ModelFile = {
  name: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin',
  bytes: 574_041_195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
}

/**
 * Silero VAD for whisper.cpp, run on each chunk before Whisper. The chunker's energy detector
 * finds where to cut, but can't tell a voice from a keyboard or the echo of a call that slipped
 * past the gate, and Whisper invents words for those ("Hello? Hello?"). Silero only passes
 * speech, so Whisper only hears speech.
 */
const VAD_MODEL: ModelFile = {
  name: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin',
  bytes: 885_098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
}

/** How recordings name the model in their passes. */
export const MODEL_LABEL = 'whisper large-v3-turbo q5 (chunked)'

type NativeWhisper = (
  options: Record<string, unknown>,
  callback: (error: Error | null, result: { transcription: string[][] | string[] }) => void
) => void

type TranscribeFn = (options: Record<string, unknown>) => Promise<{
  transcription: string[][] | string[]
}>

const require = createRequire(import.meta.url)
let transcribeFn: TranscribeFn | null = null

export function modelPath(): string {
  return join(modelsDir(), MODEL.name)
}

export function broadcastStatus(status: WhisperStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('whisper:status', status)
  }
}

function addonFolder(): string {
  const os = platform()
  const cpu = arch()
  if (os === 'darwin' && cpu === 'arm64') return 'mac-arm64'
  if (os === 'darwin') return 'mac-x64'
  if (os === 'win32') return 'win32-x64'
  if (os === 'linux' && cpu === 'arm64') return 'linux-arm64'
  return 'linux-x64'
}

function loadTranscribe(): TranscribeFn {
  if (transcribeFn) return transcribeFn

  const pkgRoot = join(require.resolve('@kutalia/whisper-node-addon/package.json'), '..')
  const addonPath = join(pkgRoot, 'dist', addonFolder(), 'whisper.node')
  const native = require(addonPath) as { whisper: NativeWhisper }
  const run: TranscribeFn = (options) =>
    new Promise((resolve, reject) => {
      native.whisper(options, (error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
    })
  transcribeFn = run
  return run
}

// Every dictation calls ensureModel(), so remember a verified model instead of re-checking it.
let modelReady = false

export async function ensureModel(): Promise<void> {
  if (modelReady) return
  if (await hasModelFile(MODEL)) {
    // Present already: at most a one-time hash of a copy downloaded before pinning, no progress UI.
    await ensureModelFile(MODEL)
  } else {
    try {
      await ensureModelFile(MODEL, (received, total) => {
        broadcastStatus({ state: 'downloading', received, total })
      })
    } finally {
      broadcastStatus({ state: 'idle' })
    }
  }
  await ensureModelFile(VAD_MODEL)
  // Where chunks start and end; recording falls back to the energy detector without it.
  await ensureSpeechVad()
  modelReady = true
}

/**
 * whisper.cpp's Silero pass, set rather than left to its defaults. Those pad speech by only 30 ms,
 * far less than the chunker keeps around it (300 ms pre-roll and tail), so word edges could be
 * cut. The chunker has already found speech, so this pass only removes what clearly isn't: a
 * lower bar than the default 0.5, and 200 ms of padding on each side.
 */
const VAD_OPTIONS = {
  vad_threshold: 0.35,
  vad_min_speech_duration_ms: 150,
  vad_min_silence_duration_ms: 300,
  vad_speech_pad_ms: 200
}

const BASE_OPTIONS = {
  translate: false,
  no_timestamps: false,
  // One row per token, so the renderer gets word-level timestamps.
  max_len: 1,
  no_prints: true
}

let useGpu = true
/**
 * GPU failures since launch. After the first, Whisper runs on the CPU until the next recording
 * tries the GPU again (`retryGpu`); after the second, until the app restarts.
 */
let gpuFailures = 0
const GPU_RETRIES = 1
// The native addon shares one whisper context, so calls must never overlap.
let queue: Promise<unknown> = Promise.resolve()

function runSerial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function runWhisper(pcm: Float32Array, prompt: string): Promise<TranscriptWord[]> {
  const transcribe = loadTranscribe()
  const options = {
    ...BASE_OPTIONS,
    model: modelPath(),
    // Read per chunk, so a change in Settings applies to the next one.
    language: getSettings().transcriptionLanguage,
    vad: true,
    vad_model: join(modelsDir(), VAD_MODEL.name),
    ...VAD_OPTIONS,
    pcmf32: pcm,
    prompt
  }
  try {
    return wordsFromTokens(await transcribe({ ...options, use_gpu: useGpu }))
  } catch (gpuError) {
    if (!useGpu) throw gpuError
    gpuFailures++
    useGpu = false
    // Once per failure, not per chunk: every later chunk runs on CPU, several times slower.
    log('whisper', 'GPU transcription failed; transcribing on the CPU', {
      error: gpuError instanceof Error ? gpuError.message : String(gpuError),
      failures: gpuFailures,
      until: gpuFailures > GPU_RETRIES ? 'restart' : 'next recording'
    })
    return wordsFromTokens(await transcribe({ ...options, use_gpu: false }))
  }
}

/** Where Whisper runs right now. */
export function whisperBackend(): 'gpu' | 'cpu' {
  return useGpu ? 'gpu' : 'cpu'
}

/**
 * Gives the GPU another try at the start of a recording after one failure (a driver reset, the
 * GPU busy elsewhere), rather than leaving every later recording on the CPU until a restart. The
 * call is the same one the first chunk made; if it fails again the chunk falls back as before.
 */
export function retryGpu(): void {
  if (useGpu || gpuFailures > GPU_RETRIES) return
  useGpu = true
  log('whisper', 'trying the GPU again', { failures: gpuFailures })
}

let warmed: Promise<void> | null = null

/** Loads the model into memory ahead of the first real utterance (~3s cold start). */
export function warmUp(): Promise<void> {
  warmed ??= ensureModel()
    .then(() => runSerial(() => runWhisper(new Float32Array(16000), '')))
    .then(() => undefined)
    .catch((error: unknown) => {
      warmed = null
      throw error
    })
  return warmed
}

/** Transcribes 16 kHz mono PCM into words with timestamps relative to the start of `pcm`. */
export async function transcribePcm(pcm: Float32Array, context = ''): Promise<TranscriptWord[]> {
  if (pcm.length < 4800) return []
  await ensureModel()
  // Read per chunk so a Settings change applies to the next one; an empty list leaves `context` as is.
  const prompt = withVocabulary(context, getSettings().vocabulary)
  const queuedAt = Date.now()
  let startedAt = 0
  // whisper.cpp can't be cancelled, so a hung call blocks every later one; make that visible.
  const watchdog = setInterval(() => {
    log('whisper', 'transcription is taking unusually long', {
      waitedMs: Date.now() - queuedAt,
      runningMs: startedAt ? Date.now() - startedAt : 0,
      audioSec: +(pcm.length / 16000).toFixed(2)
    })
  }, 10_000)

  try {
    const words = await runSerial(() => {
      startedAt = Date.now()
      return runWhisper(pcm, prompt)
    })
    const audioSec = pcm.length / 16000
    const runMs = Date.now() - startedAt
    const dropped = isHallucination(words, prompt, audioSec)
    // Counts only: transcripts never go in the log (AGENTS.md).
    log('whisper', dropped ? 'dropped as hallucination' : 'transcribed', {
      audioSec: +audioSec.toFixed(2),
      queuedMs: startedAt - queuedAt,
      runMs,
      // Over 1, Whisper is slower than the talk and recordings build a backlog.
      rtf: +(runMs / 1000 / audioSec).toFixed(3),
      backend: whisperBackend(),
      promptChars: prompt.length,
      words: words.length
    })
    return dropped ? [] : words
  } catch (error) {
    log('whisper', 'transcription failed', error)
    throw error
  } finally {
    clearInterval(watchdog)
  }
}

import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { TranscriptWord, WhisperStatus } from '../shared/types'
import hallucinationList from './data/hallucinations.json'
import { log } from './log'
import { getSettings } from './settings'
import { ensureModelFile, hasModelFile, modelsDir, type ModelFile } from './models'

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
  modelReady = true
}

/** A sentence this many times, making up this share of a chunk, is Whisper looping. */
const LOOP_REPEATS = 3
const LOOP_SHARE = 0.6

function seconds(stamp: unknown): number {
  const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(stamp))
  if (!match) return 0
  const [, h = 0, m = 0, s = 0, ms = 0] = match.map(Number)
  return h * 3600 + m * 60 + s + ms / 1000
}

/**
 * With `max_len: 1` Whisper returns one row per token: [start, end, text].
 * Tokens that start with a space begin a new word; the rest (punctuation,
 * word pieces) attach to the previous word. Annotations such as [BLANK_AUDIO],
 * (music) or *Gunshot* (large-v3-turbo's name for a keyboard click) are dropped.
 */
function wordsFromTokens(result: { transcription?: unknown }): TranscriptWord[] {
  const rows: unknown[] = Array.isArray(result.transcription) ? result.transcription : []
  const words: TranscriptWord[] = []
  let bracketDepth = 0
  let starred = false

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue
    const text = String(row[2] ?? '')
    const start = seconds(row[0])
    const end = seconds(row[1])
    const opens = (text.match(/[[(]/g) ?? []).length
    const closes = (text.match(/[\])]/g) ?? []).length
    const stars = (text.match(/\*/g) ?? []).length
    const inside = bracketDepth > 0 || opens > 0 || starred || stars > 0
    bracketDepth = Math.max(0, bracketDepth + opens - closes)
    if (stars % 2 === 1) starred = !starred
    if (inside || !text.trim()) continue

    const last = words.at(-1)
    if (last && !/^\s/.test(text)) {
      last.text += text
      last.end = end
    } else {
      words.push({ text: ` ${text.trim()}`, start, end })
    }
  }
  // Whisper marks speech that runs past the end of the buffer with "..."; that is not dictation.
  return words
    .map((word) => ({ ...word, text: word.text.replace(/(?:\.\.\.|…)+/g, '') }))
    .filter((word) => word.text.trim())
}

/** Letters and digits in any script, lowercased, single-spaced: "I'm" and "i m" compare equal. */
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const HallucinationList = z.object({ phrases: z.array(z.string()) })

/**
 * What Whisper writes when it hears no speech ("Thanks for watching", "Subtitles by the Amara.org
 * community", and the same in other languages), from published lists pulled in by
 * `scripts/update-word-lists.cjs`. Only a whole chunk that is one of these is dropped.
 */
const HALLUCINATIONS = new Set(HallucinationList.parse(hallucinationList).phrases.map(normalize).filter(Boolean))

/**
 * Whisper looping on a sound it can't make out: mostly one sentence over and over ("I'm very
 * impressed. I'm very impressed. I'm very impressed."). Real speech repeats a word, rarely a
 * whole chunk of the same sentence.
 */
function isLoop(raw: string): boolean {
  const sentences = raw
    .split(/(?<=[.!?。！？।؟])\s*/u)
    .map(normalize)
    .filter(Boolean)
  if (sentences.length < LOOP_REPEATS) return false
  const counts = new Map<string, number>()
  for (const sentence of sentences) counts.set(sentence, (counts.get(sentence) ?? 0) + 1)
  const most = Math.max(...counts.values())
  return most >= LOOP_REPEATS && most / sentences.length >= LOOP_SHARE
}

/** Drops the stock phrases Whisper invents on silence, loops, and echoes of its own prompt. */
function isHallucination(words: TranscriptWord[], prompt: string): boolean {
  const raw = words.map((word) => word.text).join('')
  const text = normalize(raw)
  if (!text || HALLUCINATIONS.has(text) || isLoop(raw)) return true
  return text.length > 12 && normalize(prompt).includes(text)
}

const BASE_OPTIONS = {
  translate: false,
  no_timestamps: false,
  // One row per token, so the renderer gets word-level timestamps.
  max_len: 1,
  no_prints: true
}

let useGpu = true
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
    pcmf32: pcm,
    prompt
  }
  try {
    return wordsFromTokens(await transcribe({ ...options, use_gpu: useGpu }))
  } catch (gpuError) {
    if (!useGpu) throw gpuError
    log('whisper', 'GPU transcription failed, falling back to CPU', gpuError)
    useGpu = false
    return wordsFromTokens(await transcribe({ ...options, use_gpu: false }))
  }
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
export async function transcribePcm(pcm: Float32Array, prompt = ''): Promise<TranscriptWord[]> {
  if (pcm.length < 4800) return []
  await ensureModel()
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
    const dropped = isHallucination(words, prompt)
    // Counts only: transcripts never go in the log (AGENTS.md).
    log('whisper', dropped ? 'dropped as hallucination' : 'transcribed', {
      audioSec: +(pcm.length / 16000).toFixed(2),
      queuedMs: startedAt - queuedAt,
      runMs: Date.now() - startedAt,
      gpu: useGpu,
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

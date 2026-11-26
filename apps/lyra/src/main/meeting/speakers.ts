import { utilityProcess, type UtilityProcess } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../log'
import { getSettings } from '../settings'
import { ensureModelFile, type DownloadProgress, type ModelFile } from '../models'
import type {
  DiarizeRequest,
  DiarizeResult,
  RollRequest,
  RollResult,
  SpeakerModels,
  WorkerRequest,
  WorkerResponse
} from './protocol'
import { SPEAKER_EMBEDDING } from './speakerModel'
import { SAMPLE_RATE } from './wav'

const SEGMENTATION: ModelFile = {
  name: 'pyannote-segmentation-3.0.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx',
  bytes: 5_992_913,
  sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
}

/**
 * NVIDIA NeMo TitaNet-small. It replaced WeSpeaker ResNet34, which scored different people at one
 * desk mic as alike as one person (0.9 and up), so no threshold could split them. With TitaNet a
 * saved voice scores 0.73+ against its owner and under 0.35 against anyone else
 * (scripts/eval/voice-scores.cjs), and it clustered the real-voice sessions best of the models
 * tried (ResNet34, CAM++, ERes2Net; scripts/eval/cluster-lab.cjs). A GitHub release asset: the
 * tag could be re-uploaded, so the hash is what pins it.
 */
const EMBEDDING: ModelFile = {
  name: SPEAKER_EMBEDDING.model,
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
  bytes: 40_257_283,
  sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e'
}

/**
 * NVIDIA Nemotron 3 Diarization (OpenMDW licence), the 8-bit ONNX export: the graph and its
 * weights, which the graph finds beside it under that exact name. Opt-in ("Larger speaker
 * model" in Settings): on real far-field meetings it found the right number of people and
 * halved the words given to the wrong one (docs/EVALS.md), for a 121 MB download.
 */
const ACTIVITY_REVISION =
  'https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX/resolve/353b6f8ad2cac3580e982d7fbdf0a010786b0406/onnx'
const ACTIVITY: ModelFile = {
  name: 'nemotron-3-diarization/model_quantized.onnx',
  url: `${ACTIVITY_REVISION}/model_quantized.onnx`,
  bytes: 364_375,
  sha256: 'fff7d18c7439c9fdc1c6c4dfec924cb42d3344264ca879780dfaf7ee886e6c1e'
}
const ACTIVITY_WEIGHTS: ModelFile = {
  name: 'nemotron-3-diarization/model_quantized.onnx_data',
  url: `${ACTIVITY_REVISION}/model_quantized.onnx_data`,
  bytes: 120_479_872,
  sha256: '002d7483e1c865c35c82220fdb378f185ff213c6d35922b38ae421c8ec72c338'
}

/** ONNX Runtime, which runs the activity model, publishes no build for Intel Macs. */
const ACTIVITY_AVAILABLE = !(process.platform === 'darwin' && process.arch === 'x64')

/**
 * Downloads the segmentation and speaker-embedding models on first use (~46 MB), and the
 * activity model too when the setting asks for it.
 */
export async function ensureSpeakerModels(onProgress?: DownloadProgress): Promise<SpeakerModels> {
  const larger = ACTIVITY_AVAILABLE && getSettings().largerSpeakerModel
  // Approximate combined progress across the files (sizes known in advance).
  const base = SEGMENTATION.bytes + EMBEDDING.bytes
  const total = base + (larger ? ACTIVITY.bytes + ACTIVITY_WEIGHTS.bytes : 0)
  const segmentation = await ensureModelFile(
    SEGMENTATION,
    onProgress && ((received) => {
      onProgress(received, total)
    })
  )
  const embedding = await ensureModelFile(
    EMBEDDING,
    onProgress && ((received) => {
      onProgress(SEGMENTATION.bytes + received, total)
    })
  )
  if (!larger) return { segmentation, embedding, activity: null }
  await ensureModelFile(
    ACTIVITY_WEIGHTS,
    onProgress && ((received) => {
      onProgress(base + received, total)
    })
  )
  const activity = await ensureModelFile(ACTIVITY)
  return { segmentation, embedding, activity }
}

type Pending = {
  resolve: (value: DiarizeResult | RollResult | number[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  /** The worker it was sent to: only that worker's exit fails it. */
  child: UtilityProcess
}

let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): UtilityProcess {
  if (worker) return worker
  const child = utilityProcess.fork(join(__dirname, 'speakerWorker.js'), [], {
    serviceName: 'Lyra speaker worker'
  })
  child.on('message', (message: WorkerResponse) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  })
  child.on('exit', (code) => {
    log('speakers', 'worker exited', { code })
    if (worker === child) worker = null
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error('Speaker worker stopped'))
    }
  })
  worker = child
  return child
}

type Request =
  | Omit<DiarizeRequest, 'id'>
  | Omit<RollRequest, 'id'>
  | { type: 'embed'; samples: Float32Array; models: SpeakerModels }

/**
 * How long a request may take before the worker is taken to be hung (a native call that never
 * returns would otherwise leave the session "diarizing" for good). Diarization runs well under
 * real time; this allows several times real time on top of a fixed allowance for loading models.
 */
const TIMEOUT_BASE_MS = 3 * 60_000
const TIMEOUT_PER_AUDIO_SECOND_MS = 3_000

export function requestTimeoutMs(audioSeconds: number): number {
  return TIMEOUT_BASE_MS + Math.max(0, audioSeconds) * TIMEOUT_PER_AUDIO_SECOND_MS
}

function send(request: Request, timeoutMs: number): Promise<DiarizeResult | RollResult | number[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const child = getWorker()
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      log('speakers', 'worker request timed out; restarting it', { type: request.type, seconds: timeoutMs / 1000 })
      reject(new Error('The speaker worker stopped responding'))
      // The exit handler fails any other request it held; the next request starts a fresh one.
      if (worker === child) worker = null
      child.kill()
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer, child })
    const message: WorkerRequest = { ...request, id }
    child.postMessage(message)
  })
}

/** Seconds of audio in a recording's WAV files (16-bit mono), from their size. */
export async function audioSeconds(paths: readonly (string | null)[]): Promise<number> {
  let bytes = 0
  for (const path of paths) if (path) bytes = Math.max(bytes, (await stat(path)).size)
  return bytes / (SAMPLE_RATE * 2)
}

export async function diarize(request: Omit<DiarizeRequest, 'type'>): Promise<DiarizeResult> {
  const seconds = await audioSeconds([request.micPath, request.systemPath])
  const result = await send({ type: 'diarize', ...request }, requestTimeoutMs(seconds))
  if (Array.isArray(result)) throw new Error('Unexpected worker reply')
  return result
}

/**
 * Diarizes the recording `key` names as far as its files go now (`rollingDiarizer.ts`). The
 * first round of a take that continues a long session works through all of it, so the allowance
 * is the same as a whole pass.
 */
export async function rollDiarize(request: Omit<RollRequest, 'type'>): Promise<RollResult> {
  const seconds = await audioSeconds([request.micPath, request.systemPath])
  const result = await send({ type: 'roll', ...request }, requestTimeoutMs(seconds))
  if (Array.isArray(result) || !('stats' in result)) throw new Error('Unexpected worker reply')
  return result
}

export async function embedVoice(samples: Float32Array, models: SpeakerModels): Promise<number[]> {
  const result = await send({ type: 'embed', samples, models }, requestTimeoutMs(samples.length / SAMPLE_RATE))
  if (!Array.isArray(result)) throw new Error('Unexpected worker reply')
  return result
}

export function stopSpeakerWorker(): void {
  worker?.kill()
  worker = null
}

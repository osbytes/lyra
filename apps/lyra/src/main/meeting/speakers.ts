import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../log'
import { onActivityAction } from '../activity'
import { getSettings, onSettingsChanged, updateSettings } from '../settings'
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
import { ActivityCheckResult } from './activityProtocol'
import { ActivityModelError, withStandardFallback } from './activityFallback'
import { clearLargerModelFailure, reportLargerModelCheck, reportLargerModelFailure } from './meetingActivity'
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
 * Why the larger model couldn't run, once it failed: until Retry finds it working, or the
 * setting is turned off and on, this run of the app labels with the standard model.
 */
let largerModelFailure: string | null = null

function largerModelWanted(): boolean {
  return ACTIVITY_AVAILABLE && getSettings().largerSpeakerModel && largerModelFailure === null
}

/**
 * Downloads the segmentation and speaker-embedding models on first use (~46 MB), and the
 * activity model too when the setting asks for it (and it hasn't failed to run).
 */
export async function ensureSpeakerModels(onProgress?: DownloadProgress): Promise<SpeakerModels> {
  const larger = largerModelWanted()
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
  const activity = await ensureActivityModel(
    onProgress && ((received) => {
      onProgress(base + received, total)
    })
  )
  return { segmentation, embedding, activity }
}

async function ensureActivityModel(onProgress?: (received: number) => void): Promise<string> {
  await ensureModelFile(ACTIVITY_WEIGHTS, onProgress)
  return ensureModelFile(ACTIVITY)
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
    else entry.reject(message.activityModel ? new ActivityModelError(message.error) : new Error(message.error))
  })
  child.on('exit', (code) => {
    log('speakers', 'worker exited', { code })
    if (worker === child) worker = null
    if (activityWorker?.speaker === child) {
      activityWorker.child.kill()
      activityWorker = null
    }
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

/** The activity worker (`activityWorker.ts`) and the speaker worker it answers. */
let activityWorker: { child: UtilityProcess; speaker: UtilityProcess } | null = null

function forkActivityWorker(): UtilityProcess {
  return utilityProcess.fork(join(__dirname, 'activityWorker.js'), [], {
    serviceName: 'Lyra speaker model worker'
  })
}

/**
 * Starts the activity worker for `speaker` and hands each a port to the other. The port is
 * posted before the request that needs it, so it arrives first.
 */
function connectActivityWorker(speaker: UtilityProcess): void {
  if (activityWorker?.speaker === speaker) return
  activityWorker?.child.kill()
  const child = forkActivityWorker()
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage(null, [port1])
  speaker.postMessage(null, [port2])
  child.on('exit', (code) => {
    log('speakers', 'activity worker exited', { code })
    if (activityWorker?.child === child) activityWorker = null
  })
  activityWorker = { child, speaker }
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
    if (request.models.activity) connectActivityWorker(child)
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

/** The larger model failed: label with the standard one from now on, and say so once. */
function fallBack(reason: string): void {
  log('speakers', 'larger model failed; using the standard one', { error: reason })
  largerModelFailure = reason
  reportLargerModelFailure()
}

export async function diarize(request: Omit<DiarizeRequest, 'type'>): Promise<DiarizeResult> {
  const seconds = await audioSeconds([request.micPath, request.systemPath])
  return withStandardFallback(
    request.models,
    async (models) => {
      const result = await send({ type: 'diarize', ...request, models }, requestTimeoutMs(seconds))
      if (Array.isArray(result)) throw new Error('Unexpected worker reply')
      return result
    },
    fallBack
  )
}

/**
 * Diarizes the recording `key` names as far as its files go now (`rollingDiarizer.ts`). The
 * first round of a take that continues a long session works through all of it, so the allowance
 * is the same as a whole pass.
 */
export async function rollDiarize(request: Omit<RollRequest, 'type'>): Promise<RollResult> {
  const seconds = await audioSeconds([request.micPath, request.systemPath])
  return withStandardFallback(
    request.models,
    async (models) => {
      const result = await send({ type: 'roll', ...request, models }, requestTimeoutMs(seconds))
      if (Array.isArray(result) || !('stats' in result)) throw new Error('Unexpected worker reply')
      return result
    },
    fallBack
  )
}

export async function embedVoice(samples: Float32Array, models: SpeakerModels): Promise<number[]> {
  const result = await send({ type: 'embed', samples, models }, requestTimeoutMs(samples.length / SAMPLE_RATE))
  if (!Array.isArray(result)) throw new Error('Unexpected worker reply')
  return result
}

export function stopSpeakerWorker(): void {
  worker?.kill()
  worker = null
  activityWorker?.child.kill()
  activityWorker = null
}

const CHECK_TIMEOUT_MS = 60_000

/** Loads the larger model in a worker of its own and says whether it can run here. */
async function checkLargerModel(): Promise<ActivityCheckResult> {
  const modelPath = await ensureActivityModel()
  const child = forkActivityWorker()
  try {
    return await new Promise<ActivityCheckResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: 'The speaker model took too long to load' })
      }, CHECK_TIMEOUT_MS)
      child.on('message', (message: unknown) => {
        clearTimeout(timer)
        const parsed = ActivityCheckResult.safeParse(message)
        resolve(parsed.success ? parsed.data : { ok: false, error: 'Unexpected worker reply' })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `The speaker model worker stopped (code ${String(code)})` })
      })
      child.postMessage({ type: 'check', modelPath })
    })
  } finally {
    child.kill()
  }
}

/** Retry from Activity: checks the larger model loads now; if it does, the next labeling uses it. */
async function retryLargerModel(): Promise<void> {
  reportLargerModelCheck()
  const result = await checkLargerModel()
  log('speakers', 'larger model checked', result.ok ? { ok: true } : { ok: false, error: result.error })
  if (!result.ok) {
    largerModelFailure = result.error
    reportLargerModelFailure()
    return
  }
  largerModelFailure = null
  // A worker that failed to load it may still hold that failure; the next request starts afresh.
  activityWorker?.child.kill()
  activityWorker = null
  clearLargerModelFailure()
}

onActivityAction('speakers', async (item, action) => {
  if (item.id !== 'speakers:larger-model') return
  if (action === 'retry') await retryLargerModel()
  // The settings listener below clears the row.
  if (action === 'turnOff') await updateSettings({ largerSpeakerModel: false })
})

onSettingsChanged((next, previous) => {
  if (next.largerSpeakerModel === previous.largerSpeakerModel) return
  // Turned off, or back on to try again: either way the old failure no longer applies.
  largerModelFailure = null
  clearLargerModelFailure()
})

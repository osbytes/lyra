import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import { ensureModelFile, type DownloadProgress, type ModelFile } from '../models'
import type {
  DiarizeRequest,
  DiarizeResult,
  SpeakerModels,
  WorkerRequest,
  WorkerResponse
} from './protocol'

const SEGMENTATION: ModelFile = {
  name: 'pyannote-segmentation-3.0.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx',
  bytes: 5_992_913,
  sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
}
// A GitHub release asset: the tag could be re-uploaded, so the hash is what pins it.
const EMBEDDING: ModelFile = {
  name: 'wespeaker-en-voxceleb-resnet34-LM.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
  bytes: 26_530_550,
  sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012'
}

/** Downloads the segmentation and speaker-embedding models on first use (~32 MB). */
export async function ensureSpeakerModels(onProgress?: DownloadProgress): Promise<SpeakerModels> {
  // Approximate combined progress across both files (sizes known in advance).
  const total = SEGMENTATION.bytes + EMBEDDING.bytes
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
  return { segmentation, embedding }
}

type Pending = { resolve: (value: DiarizeResult | number[]) => void; reject: (error: Error) => void }

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
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  })
  child.on('exit', (code) => {
    log('speakers', 'worker exited', { code })
    if (worker === child) worker = null
    for (const entry of pending.values()) entry.reject(new Error('Speaker worker stopped'))
    pending.clear()
  })
  worker = child
  return child
}

type Request = Omit<DiarizeRequest, 'id'> | { type: 'embed'; samples: Float32Array; models: SpeakerModels }

function send(request: Request): Promise<DiarizeResult | number[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const message: WorkerRequest = { ...request, id }
    getWorker().postMessage(message)
  })
}

export async function diarize(request: Omit<DiarizeRequest, 'type'>): Promise<DiarizeResult> {
  const result = await send({ type: 'diarize', ...request })
  if (Array.isArray(result)) throw new Error('Unexpected worker reply')
  return result
}

export async function embedVoice(samples: Float32Array, models: SpeakerModels): Promise<number[]> {
  const result = await send({ type: 'embed', samples, models })
  if (!Array.isArray(result)) throw new Error('Unexpected worker reply')
  return result
}

export function stopSpeakerWorker(): void {
  worker?.kill()
  worker = null
}

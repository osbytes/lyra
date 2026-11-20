/**
 * Speaker worker, run with Electron's utilityProcess so the native diarization
 * work (seconds to minutes per meeting) never blocks the main process.
 */
import {
  OfflineSpeakerDiarization,
  SpeakerEmbeddingExtractor,
  type SpeakerDiarizationSegment
} from 'sherpa-onnx-node'
import type {
  ClusterEmbedding,
  DiarizeRequest,
  DiarizeResult,
  DiarizedSegment,
  SpeakerModels,
  WorkerRequest,
  WorkerResponse
} from './protocol'
import { energy, mixTracks, readWav, SAMPLE_RATE } from './wav'

/** Audio per speaker used for their voiceprint: enough to be stable, cheap to compute. */
const EMBEDDING_SECONDS = 30
const THREADS = 2

let extractor: { model: string; instance: SpeakerEmbeddingExtractor } | null = null

function getExtractor(model: string): SpeakerEmbeddingExtractor {
  if (extractor?.model !== model) {
    extractor = { model, instance: new SpeakerEmbeddingExtractor({ model, numThreads: THREADS }) }
  }
  return extractor.instance
}

function embed(models: SpeakerModels, samples: Float32Array): number[] {
  const instance = getExtractor(models.embedding)
  const stream = instance.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  stream.inputFinished()
  // Electron's memory cage rejects the addon's zero-copy buffers, so ask for a copy.
  return Array.from(instance.compute(stream, false))
}

/** A voiceprint per speaker from their longest segments, up to EMBEDDING_SECONDS. */
function clusterEmbeddings(
  models: SpeakerModels,
  audio: Float32Array,
  segments: SpeakerDiarizationSegment[]
): ClusterEmbedding[] {
  const speakers = [...new Set(segments.map((segment) => segment.speaker))]
  return speakers.map((speaker) => {
    const own = segments
      .filter((segment) => segment.speaker === speaker)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
    const parts: Float32Array[] = []
    let total = 0
    for (const segment of own) {
      if (total >= EMBEDDING_SECONDS * SAMPLE_RATE) break
      const part = audio.subarray(
        Math.floor(segment.start * SAMPLE_RATE),
        Math.ceil(segment.end * SAMPLE_RATE)
      )
      parts.push(part)
      total += part.length
    }
    const joined = new Float32Array(total)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    return { speaker, embedding: embed(models, joined) }
  })
}

async function diarize(request: DiarizeRequest): Promise<DiarizeResult> {
  const mic = await readWav(request.micPath)
  const system = request.systemPath ? await readWav(request.systemPath) : null
  const audio = mixTracks(mic, system)

  const diarizer = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: request.models.segmentation }, numThreads: THREADS },
    embedding: { model: request.models.embedding, numThreads: THREADS },
    clustering: { numClusters: -1, threshold: request.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const raw = diarizer.process(audio)

  const segments: DiarizedSegment[] = raw.map((segment) => {
    const start = Math.floor(segment.start * SAMPLE_RATE)
    const end = Math.ceil(segment.end * SAMPLE_RATE)
    const micEnergy = energy(mic, start, end)
    const systemEnergy = system ? energy(system, start, end) : 0
    const total = micEnergy + systemEnergy
    return { ...segment, micShare: total > 0 ? micEnergy / total : 1 }
  })

  return {
    seconds: audio.length / SAMPLE_RATE,
    segments,
    clusters: clusterEmbeddings(request.models, audio, raw)
  }
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    const result =
      request.type === 'diarize'
        ? await diarize(request)
        : embed(request.models, request.samples)
    return { id: request.id, ok: true, result }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const request = event.data as WorkerRequest
  void handle(request).then((response) => {
    process.parentPort.postMessage(response)
  })
})

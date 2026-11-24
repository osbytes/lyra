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
import {
  clusterLongWindows,
  foldShortSpeakers,
  labelTimeline,
  speechWindows,
  unit,
  type Span
} from './clustering'
import { energy, mixTracks, readWav, SAMPLE_RATE } from './wav'

/** Audio per speaker used for their voiceprint: enough to be stable, cheap to compute. */
const EMBEDDING_SECONDS = 30
const THREADS = 2
/** Window length for clustering: long enough for a steady voiceprint, short enough for quick turns. */
const WINDOW_SECONDS = 3
/** Windows shorter than this don't shape the clusters; they take the nearest speaker after. */
const MIN_WINDOW_SECONDS = 1
/**
 * A "speaker" with fewer seconds of windows than this is folded into the closest one: a few
 * windows of their own are usually one person's cough, laugh or a stretch of crosstalk. Windows
 * half-overlap, so this counts about twice their speech. 15 s in a session of minutes (the eval
 * sweep's best), scaled down for short recordings so a second voice in a one-minute note counts.
 */
function minSpeakerSeconds(windowSeconds: number): number {
  return Math.min(15, Math.max(5, windowSeconds * 0.08))
}
/** Lets the segmentation step cut at every change of voice; our clustering decides who is who. */
const SEGMENTATION_THRESHOLD = 0.5

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
  segments: readonly SpeakerDiarizationSegment[]
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

  // sherpa-onnx finds the speech and where voices change; its own clustering of short pieces
  // can't tell people at one desk mic apart, so its labels are dropped and ours are used.
  const diarizer = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: request.models.segmentation }, numThreads: THREADS },
    embedding: { model: request.models.embedding, numThreads: THREADS },
    clustering: { numClusters: -1, threshold: SEGMENTATION_THRESHOLD },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const pieces: Span[] = diarizer
    .process(audio)
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
  const windows = speechWindows(pieces, WINDOW_SECONDS)
  const prints = windows.map(({ start, end }) =>
    unit(
      embed(
        request.models,
        audio.subarray(Math.floor(start * SAMPLE_RATE), Math.ceil(end * SAMPLE_RATE))
      )
    )
  )
  const labels = foldShortSpeakers(
    clusterLongWindows(windows, prints, request.threshold, MIN_WINDOW_SECONDS),
    windows,
    prints,
    minSpeakerSeconds(windows.reduce((sum, w) => sum + w.end - w.start, 0))
  )
  const raw: SpeakerDiarizationSegment[] = labelTimeline(windows, labels)

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

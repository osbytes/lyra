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
  RollRequest,
  RollResult,
  SpeakerModels,
  WorkerRequest,
  WorkerResponse
} from './protocol'
import {
  clusterLongWindows,
  foldShortSpeakers,
  labelTimeline,
  minSpeakerSeconds,
  speechWindows,
  unit,
  type Span
} from './clustering'
import { advance, emptyRolling, rollingResult, type RollingState } from './rollingDiarizer'
import { energy, mixTracks, readWav, SAMPLE_RATE } from './wav'

/** Audio per speaker used for their voiceprint: enough to be stable, cheap to compute. */
const EMBEDDING_SECONDS = 30
const THREADS = 2
/** Window length for clustering: long enough for a steady voiceprint, short enough for quick turns. */
const WINDOW_SECONDS = 3
/** Windows shorter than this don't shape the clusters; they take the nearest speaker after. */
const MIN_WINDOW_SECONDS = 1
/**
 * A speaker under that bar who has this many transcribed words to themselves is kept: a cough
 * or laugh has none, and a person who said one sentence is still a person.
 */
const MIN_OWN_WORDS = 5
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

/**
 * sherpa-onnx finds the speech and where voices change; its own clustering of short pieces
 * can't tell people at one desk mic apart, so its labels are dropped and ours are used.
 */
function segmenter(models: SpeakerModels): OfflineSpeakerDiarization {
  return new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models.segmentation }, numThreads: THREADS },
    embedding: { model: models.embedding, numThreads: THREADS },
    clustering: { numClusters: -1, threshold: SEGMENTATION_THRESHOLD },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
}

function speechPieces(diarizer: OfflineSpeakerDiarization, audio: Float32Array): Span[] {
  return diarizer
    .process(audio)
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
}

/** The recording being diarized as it grows: what `rollingDiarizer.ts` has settled of it. */
let rolling: { key: string; diarizer: OfflineSpeakerDiarization; state: RollingState } | null = null

/**
 * Who spoke when in a recording still being made, from the audio since the last round and what
 * earlier rounds kept. A session's audio only ever grows while it is recorded, so what was
 * settled stays true; another recording starts over. One round at a time (the caller waits).
 */
async function roll(request: RollRequest): Promise<RollResult> {
  const started = Date.now()
  const current =
    rolling?.key === request.key
      ? rolling
      : { key: request.key, diarizer: segmenter(request.models), state: emptyRolling() }
  rolling = current
  const from = current.state.doneTo
  let mic = await readWav(request.micPath, from, Infinity, true)
  let system = request.systemPath ? await readWav(request.systemPath, from, Infinity, true) : null
  // The two files are written a batch at a time, so one can be a moment ahead of the other.
  if (system) {
    const samples = Math.min(mic.length, system.length)
    mic = mic.subarray(0, samples)
    system = system.subarray(0, samples)
  }
  const { diarizer } = current
  const { state, tail } = advance(
    current.state,
    { mic, system },
    {
      sampleRate: SAMPLE_RATE,
      windowSeconds: WINDOW_SECONDS,
      minWindowSeconds: MIN_WINDOW_SECONDS,
      // Under a second there is nothing to find, and the model isn't made for it.
      segment: (audio) => (audio.length < SAMPLE_RATE ? [] : speechPieces(diarizer, audio)),
      embed: (samples) => embed(request.models, samples)
    }
  )
  const embedded = state.windows.length - current.state.windows.length + tail.windows.length
  current.state = state
  const result = rollingResult(state, tail, {
    threshold: request.threshold,
    minWindowSeconds: MIN_WINDOW_SECONDS,
    minOwnWords: MIN_OWN_WORDS,
    hasSystem: system !== null,
    words: request.words
  })
  return {
    ...result,
    stats: {
      from: +from.toFixed(1),
      windows: state.windows.length + tail.windows.length,
      embedded,
      ms: Date.now() - started
    }
  }
}

async function diarize(request: DiarizeRequest): Promise<DiarizeResult> {
  const mic = await readWav(request.micPath)
  const system = request.systemPath ? await readWav(request.systemPath) : null
  const audio = mixTracks(mic, system)

  const pieces = speechPieces(segmenter(request.models), audio)
  const windows = speechWindows(pieces, WINDOW_SECONDS)
  const prints = windows.map(({ start, end }) =>
    unit(
      embed(
        request.models,
        audio.subarray(Math.floor(start * SAMPLE_RATE), Math.ceil(end * SAMPLE_RATE))
      )
    )
  )
  const micShares = system
    ? windows.map(({ start, end }) => {
        const from = Math.floor(start * SAMPLE_RATE)
        const to = Math.ceil(end * SAMPLE_RATE)
        const micEnergy = energy(mic, from, to)
        const total = micEnergy + energy(system, from, to)
        return total > 0 ? micEnergy / total : 1
      })
    : null
  const labels = foldShortSpeakers(
    clusterLongWindows(windows, prints, request.threshold, MIN_WINDOW_SECONDS),
    windows,
    prints,
    minSpeakerSeconds(windows.reduce((sum, w) => sum + w.end - w.start, 0)),
    { micShares, words: request.words, minWords: MIN_OWN_WORDS, distinct: request.threshold }
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
        : request.type === 'roll'
          ? await roll(request)
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

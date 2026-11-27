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
  MIC_SIDE,
  centroids,
  clusterLongWindows,
  foldShortSpeakers,
  labelTimeline,
  minSpeakerSeconds,
  speechWindows,
  unit,
  type Span
} from './clustering'
import { activityClient } from './activityClient'
import { ActivityModelError } from './activityFallback'
import { advance, emptyRolling, rollingResult, type RollingState } from './rollingDiarizer'
import { MEL_BANDS, MEL_HOP, logMel } from './melFeatures'
import {
  activityReader,
  activityTurns,
  readActivity,
  withoutEchoes,
  withoutFaintSpeakers,
  type Activity,
  type ActivityReader,
  type Turn
} from './speakerActivity'
import { refineEdges } from './turnEdges'
import { energy, mixTracks, readWav, SAMPLE_RATE } from './wav'

/** Audio per speaker used for their voiceprint: enough to be stable, cheap to compute. */
const EMBEDDING_SECONDS = 30
const THREADS = 2
/** The activity model is one large network, and a finished recording is waiting on it. */
const ACTIVITY_THREADS = 4
/** A speaker the activity model heard for less than this, with no words of their own, is noise. */
const MIN_ACTIVITY_SPEAKER_SECONDS = 3
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

/**
 * The larger speaker model runs in a worker of its own (`activityWorker.ts`): its ONNX Runtime
 * and sherpa-onnx's can't be loaded in one process. Main sends the port before the first request
 * that needs it.
 */
const activityWorker = activityClient()

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

/** The activity model's turns: echoes of one voice joined, and speakers who said nothing dropped. */
function turnsOf(activity: Activity, words: DiarizeRequest['words']): Turn[] {
  return withoutFaintSpeakers(withoutEchoes(activityTurns(activity)), MIN_ACTIVITY_SPEAKER_SECONDS, words, MIN_OWN_WORDS)
}

/** Audio read before the first new frame so that frame's features see what came before it. */
const LEAD_FRAMES = 5

/** A recording the activity model is reading as it grows, and each 10 ms frame's energy by track. */
let activityRolling: { key: string; reader: ActivityReader; mic: number[]; system: number[] } | null = null

/** Energy of each whole 10 ms frame of `audio`. */
function frameEnergies(audio: Float32Array): number[] {
  return Array.from({ length: Math.floor(audio.length / MEL_HOP) }, (_, frame) =>
    energy(audio, frame * MEL_HOP, (frame + 1) * MEL_HOP)
  )
}

/**
 * A round of a recording still being made, with the activity model: it reads on from where the
 * last round's answers were final, so a round costs only the new audio, and what it settles is
 * what the pass after the stop will read too (`speakerActivity.ts`).
 */
async function rollActivity(request: RollRequest, model: string): Promise<RollResult> {
  const started = Date.now()
  const current =
    activityRolling?.key === request.key
      ? activityRolling
      : { key: request.key, reader: activityReader(), mic: [], system: [] }
  activityRolling = current
  const settled = current.reader.settledFrames()
  const lead = Math.min(settled, LEAD_FRAMES)
  const from = ((settled - lead) * MEL_HOP) / SAMPLE_RATE
  let mic = await readWav(request.micPath, from, Infinity, true)
  let system = request.systemPath ? await readWav(request.systemPath, from, Infinity, true) : null
  // The two files are written a batch at a time, so one can be a moment ahead of the other.
  if (system) {
    const samples = Math.min(mic.length, system.length)
    mic = mic.subarray(0, samples)
    system = system.subarray(0, samples)
  }
  const mel = logMel(mixTracks(mic, system))
  const features = { data: mel.data.subarray(lead * MEL_BANDS), frames: mel.frames - lead }
  const activity = await current.reader.advance(features, activityWorker.step(model, ACTIVITY_THREADS), false)
  // Energies for the frames now settled are kept; the rest are this round's only.
  const micNow = [...current.mic, ...frameEnergies(mic).slice(lead)]
  const systemNow = system ? [...current.system, ...frameEnergies(system).slice(lead)] : null
  const nowSettled = current.reader.settledFrames()
  current.mic = micNow.slice(0, nowSettled)
  current.system = systemNow ? systemNow.slice(0, nowSettled) : []
  const sum = (values: readonly number[], start: number, end: number): number => {
    let total = 0
    for (let frame = Math.floor(start * 100); frame < Math.min(values.length, Math.ceil(end * 100)); frame++) {
      total += values[frame] ?? 0
    }
    return total
  }
  const turns = turnsOf(activity, request.words)
  const segments: DiarizedSegment[] = turns.map((turn) => {
    const micEnergy = sum(micNow, turn.start, turn.end)
    const total = micEnergy + (systemNow ? sum(systemNow, turn.start, turn.end) : 0)
    return { ...turn, micShare: total > 0 ? micEnergy / total : 1 }
  })
  // Voiceprints name the speakers; the audio for them is read back from the files.
  const clusters: ClusterEmbedding[] = []
  for (const speaker of new Set(turns.map((turn) => turn.speaker))) {
    const own = turns.filter((turn) => turn.speaker === speaker).sort((a, b) => b.end - b.start - (a.end - a.start))
    const parts: Float32Array[] = []
    let total = 0
    for (const turn of own) {
      if (total >= EMBEDDING_SECONDS * SAMPLE_RATE) break
      const micPart = await readWav(request.micPath, turn.start, turn.end, true)
      const systemPart = request.systemPath ? await readWav(request.systemPath, turn.start, turn.end, true) : null
      const part = mixTracks(micPart, systemPart)
      parts.push(part)
      total += part.length
    }
    const joined = new Float32Array(total)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    clusters.push({ speaker, embedding: embed(request.models, joined) })
  }
  return {
    seconds: activity.frames / 100,
    segments,
    clusters,
    stats: {
      from: +from.toFixed(1),
      windows: turns.length,
      embedded: clusters.length,
      ms: Date.now() - started
    }
  }
}

/** The recording being diarized as it grows: what `rollingDiarizer.ts` has settled of it. */
let rolling: { key: string; diarizer: OfflineSpeakerDiarization; state: RollingState } | null = null

/**
 * Who spoke when in a recording still being made, from the audio since the last round and what
 * earlier rounds kept. A session's audio only ever grows while it is recorded, so what was
 * settled stays true; another recording starts over. One round at a time (the caller waits).
 */
async function roll(request: RollRequest): Promise<RollResult> {
  if (request.models.activity) return rollActivity(request, request.models.activity)
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

  const micShareOf = ({ start, end }: Span): number => {
    const from = Math.floor(start * SAMPLE_RATE)
    const to = Math.ceil(end * SAMPLE_RATE)
    const micEnergy = energy(mic, from, to)
    const total = micEnergy + (system ? energy(system, from, to) : 0)
    return total > 0 ? micEnergy / total : 1
  }
  /** Turns from voiceprints of short windows, clustered: the path without the activity model. */
  const clustered = (): SpeakerDiarizationSegment[] => {
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
    // The windows say who; where one turn ends and the next begins is then found more finely
    // (`turnEdges.ts`). A change between the mic and the far end is left to the tracks.
    return refineEdges(
      labelTimeline(windows, labels),
      centroids(labels, prints),
      (start, end) =>
        unit(embed(request.models, audio.subarray(Math.floor(start * SAMPLE_RATE), Math.ceil(end * SAMPLE_RATE)))),
      (a, b) => micShareOf(a) >= MIC_SIDE === micShareOf(b) >= MIC_SIDE
    )
  }
  const raw: SpeakerDiarizationSegment[] = request.models.activity
    ? turnsOf(await readActivity(audio, activityWorker.step(request.models.activity, ACTIVITY_THREADS)), request.words)
    : clustered()

  const segments: DiarizedSegment[] = raw.map((segment) => ({ ...segment, micShare: micShareOf(segment) }))

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
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      activityModel: error instanceof ActivityModelError
    }
  }
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const [port] = event.ports
  if (port) {
    activityWorker.connect(port)
    return
  }
  const request = event.data as WorkerRequest
  void handle(request).then((response) => {
    process.parentPort.postMessage(response)
  })
})

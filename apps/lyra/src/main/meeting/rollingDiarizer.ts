/**
 * Diarization of a recording while it is still growing: the same windows, voiceprints and
 * clustering as the pass after a recording (`clustering.ts`), without doing the whole recording
 * again each time.
 *
 * Finding the speech and taking voiceprints is nearly all of the cost and only depends on the
 * audio near it, so each round does that for the audio since the last one and keeps the result:
 * a round costs the same a minute in as an hour in. Clustering is cheap and is what needs to see
 * everything (who is a new voice and who is someone from ten minutes ago), so it runs over every
 * window each round. The last few seconds stay unsettled: a sentence still being said is found
 * again next round, with its end.
 *
 * Pure, with the models passed in, so it's unit-tested and the worker only supplies them.
 */
import {
  centroids,
  clusterLongWindows,
  foldShortSpeakers,
  labelTimeline,
  minSpeakerSeconds,
  speechWindows,
  unit,
  type Span
} from './clustering'
import type { DiarizeResult } from './protocol'

/** Energy is kept per block of this many seconds, to tell later which track a stretch was on. */
export const BLOCK_SECONDS = 0.1
/**
 * Audio this close to the end isn't settled: the speaker may be mid-sentence, and the
 * segmentation model reads a stretch better with what follows it.
 */
export const TAIL_SECONDS = 5

export type RollingTools = {
  sampleRate: number
  windowSeconds: number
  minWindowSeconds: number
  /** Stretches of speech in `audio`, cut where the voice changes; seconds from its start. */
  segment: (audio: Float32Array) => Span[]
  embed: (samples: Float32Array) => number[]
}

/** What has been settled so far. Times are seconds from the start of the recording. */
export type RollingState = {
  /** Audio before this is done with: a whole number of blocks. */
  doneTo: number
  windows: Span[]
  /** A unit voiceprint per window. */
  prints: number[][]
  /** Energy per block on each track up to `doneTo`. */
  micEnergy: number[]
  systemEnergy: number[]
}

export function emptyRolling(): RollingState {
  return { doneTo: 0, windows: [], prints: [], micEnergy: [], systemEnergy: [] }
}

/** The audio after `state.doneTo`: both tracks start there and are equally long. */
export type RollingAudio = { mic: Float32Array; system: Float32Array | null }

/** The unsettled end of the recording, worked out this round only. */
export type RollingTail = {
  windows: Span[]
  prints: number[][]
  micEnergy: number[]
  systemEnergy: number[]
  /** Where the audio ended. */
  end: number
}

function mixed(audio: RollingAudio): Float32Array {
  const { mic, system } = audio
  if (!system) return mic
  const out = new Float32Array(mic.length)
  for (let i = 0; i < out.length; i++) {
    const sum = (mic[i] ?? 0) + (system[i] ?? 0)
    out[i] = sum > 1 ? 1 : sum < -1 ? -1 : sum
  }
  return out
}

function blockEnergies(samples: Float32Array | null, blocks: number, blockSamples: number): number[] {
  const out: number[] = []
  for (let block = 0; block < blocks; block++) {
    let sum = 0
    const end = Math.min(samples?.length ?? 0, (block + 1) * blockSamples)
    for (let i = block * blockSamples; i < end; i++) {
      const value = samples?.[i] ?? 0
      sum += value * value
    }
    out.push(sum)
  }
  return out
}

/** `pieces` cut at `at`: what lies before it, and what lies after. */
function splitAt(pieces: readonly Span[], at: number): { before: Span[]; after: Span[] } {
  const before: Span[] = []
  const after: Span[] = []
  for (const piece of pieces) {
    if (piece.start < at) before.push({ start: piece.start, end: Math.min(piece.end, at) })
    if (piece.end > at) after.push({ start: Math.max(piece.start, at), end: piece.end })
  }
  return { before, after }
}

/**
 * Takes in the audio since the last round. Speech up to `TAIL_SECONDS` before the end is settled
 * and kept; the rest is returned as this round's tail. A piece of speech that crosses that line
 * is cut there: its second half is found again next round, from the cut.
 */
export function advance(
  state: RollingState,
  audio: RollingAudio,
  tools: RollingTools
): { state: RollingState; tail: RollingTail } {
  const { sampleRate } = tools
  const blockSamples = Math.round(BLOCK_SECONDS * sampleRate)
  const from = state.doneTo
  const end = from + audio.mic.length / sampleRate
  const settledBlocks = Math.max(0, Math.floor((end - TAIL_SECONDS - from) / BLOCK_SECONDS + 1e-6))
  const doneTo = +(from + settledBlocks * BLOCK_SECONDS).toFixed(3)

  const mix = mixed(audio)
  const pieces = tools
    .segment(mix)
    .map((piece) => ({ start: from + piece.start, end: Math.min(end, from + piece.end) }))
    .filter((piece) => piece.end > piece.start)
    .sort((a, b) => a.start - b.start)
  const { before, after } = splitAt(pieces, doneTo)
  const print = (window: Span): number[] =>
    unit(
      tools.embed(
        mix.subarray(Math.floor((window.start - from) * sampleRate), Math.ceil((window.end - from) * sampleRate))
      )
    )
  const settled = speechWindows(before, tools.windowSeconds)
  const unsettled = speechWindows(after, tools.windowSeconds)
  const totalBlocks = Math.ceil(audio.mic.length / blockSamples)
  const micEnergy = blockEnergies(audio.mic, totalBlocks, blockSamples)
  const systemEnergy = blockEnergies(audio.system, totalBlocks, blockSamples)

  return {
    state: {
      doneTo,
      windows: [...state.windows, ...settled],
      prints: [...state.prints, ...settled.map(print)],
      micEnergy: [...state.micEnergy, ...micEnergy.slice(0, settledBlocks)],
      systemEnergy: [...state.systemEnergy, ...systemEnergy.slice(0, settledBlocks)]
    },
    tail: {
      windows: unsettled,
      prints: unsettled.map(print),
      micEnergy: micEnergy.slice(settledBlocks),
      systemEnergy: systemEnergy.slice(settledBlocks),
      end
    }
  }
}

/** The mic's share of the energy in [start, end), from the per-block sums; 1 when there's none. */
function micShare(mic: readonly number[], system: readonly number[], start: number, end: number): number {
  let micSum = 0
  let systemSum = 0
  const last = Math.min(mic.length, Math.ceil(end / BLOCK_SECONDS - 1e-6))
  for (let block = Math.max(0, Math.floor(start / BLOCK_SECONDS + 1e-6)); block < last; block++) {
    micSum += mic[block] ?? 0
    systemSum += system[block] ?? 0
  }
  const total = micSum + systemSum
  return total > 0 ? micSum / total : 1
}

/**
 * Who spoke when in everything heard so far: every settled window and this round's tail,
 * clustered together as the pass after a recording clusters them. A speaker's voiceprint is the
 * mean of their windows' (the audio itself isn't kept between rounds).
 */
export function rollingResult(
  state: RollingState,
  tail: RollingTail,
  options: {
    threshold: number
    minWindowSeconds: number
    minOwnWords: number
    hasSystem: boolean
    words: readonly Span[] | null
  }
): DiarizeResult {
  const windows = [...state.windows, ...tail.windows]
  const prints = [...state.prints, ...tail.prints]
  const mic = [...state.micEnergy, ...tail.micEnergy]
  const system = [...state.systemEnergy, ...tail.systemEnergy]
  const micShares = options.hasSystem ? windows.map(({ start, end }) => micShare(mic, system, start, end)) : null
  const labels = foldShortSpeakers(
    clusterLongWindows(windows, prints, options.threshold, options.minWindowSeconds),
    windows,
    prints,
    minSpeakerSeconds(windows.reduce((sum, window) => sum + window.end - window.start, 0)),
    { micShares, words: options.words, minWords: options.minOwnWords, distinct: options.threshold }
  )
  const segments = labelTimeline(windows, labels).map((segment) => ({
    ...segment,
    micShare: options.hasSystem ? micShare(mic, system, segment.start, segment.end) : 1
  }))
  const heard = new Set(segments.map((segment) => segment.speaker))
  return {
    seconds: tail.end,
    segments,
    clusters: [...centroids(labels, prints)]
      .filter(([speaker]) => heard.has(speaker))
      .map(([speaker, embedding]) => ({ speaker, embedding }))
  }
}

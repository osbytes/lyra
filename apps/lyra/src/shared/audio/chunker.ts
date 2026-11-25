import { rms, SAMPLE_RATE, VoiceDetector, type SpeechClassifier } from './vad'

/**
 * Cuts one track of a recording into chunks for whole-chunk transcription, the way WhisperX's
 * "cut and merge" does: a chunk ends at a pause, so no word straddles two chunks and nothing has
 * to overlap or be reconciled, and a long stretch without one is cut at its quietest moment
 * before Whisper's 30 s window. Context carries across chunks as text (Whisper's prompt), not
 * audio. Each chunk is contiguous audio from the session timeline, pauses included, so Whisper's
 * word times map straight back onto it.
 */

const MS = SAMPLE_RATE / 1000
/**
 * A chunk with less speech than this (frames heard as voice, not the pauses between them) waits
 * for more rather than being transcribed alone: one word on its own gives Whisper no context and
 * is where it invents the most.
 */
const MIN_SPEECH = 1000 * MS
/**
 * …unless nothing follows its last speech for this long ("Yes." and then quiet). Counted from the
 * last speech, so it includes the voice detector's end pause and must stay longer than it.
 */
const ORPHAN_WAIT = 3000 * MS
/**
 * Speech shorter than this, with nothing after it, is a cough or a click: dropped. Kept well under
 * a quick one-word reply ("No.", "Yeah."), of which Silero may hear only 200-300 ms.
 */
const MIN_ORPHAN = 200 * MS
/** Silence kept after the last speech in a chunk, so its last word isn't clipped. */
const TAIL = 300 * MS
/** Past this a chunk is cut even mid-speech, at its quietest point in the last CUT_SEARCH. */
const MAX_CHUNK = 28_000 * MS
const CUT_SEARCH = 10_000 * MS
/** Frames averaged when looking for the quietest place to cut. */
const CUT_SMOOTH = 5

export type CutChunk = {
  /** First sample of the chunk on the session timeline. */
  start: number
  pcm: Float32Array
}

type Open = {
  start: number
  frames: Float32Array[]
  levels: number[]
  /** Per frame, whether the voice detector heard it as speech. */
  voiced: boolean[]
  length: number
  /** Samples heard as speech. */
  speech: number
  /** Samples into the chunk where the latest speech ended. */
  speechEnd: number
}

function concat(frames: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length)
  let at = 0
  for (const frame of frames) {
    out.set(frame.subarray(0, Math.min(frame.length, length - at)), at)
    at += frame.length
    if (at >= length) break
  }
  return out
}

/** Marks the chunk's last `samples` as speech; frames already marked aren't counted twice. */
function markSpeech(open: Open, samples: number): void {
  let left = samples
  for (let i = open.frames.length - 1; i >= 0 && left > 0; i--) {
    const length = open.frames[i]?.length ?? 0
    left -= length
    if (open.voiced[i]) continue
    open.voiced[i] = true
    open.speech += length
  }
  open.speechEnd = open.length
}

/** What the voice detector said about the latest frame. */
type Heard = { started: Float32Array[] | null; onset: number; voiced: boolean; ended: boolean }

export class PauseChunker {
  private open: Open | null = null
  private next = 0
  private heard: Heard = { started: null, onset: 0, voiced: false, ended: false }
  /** Whether the voice detector is inside an utterance (its end pause included). */
  private talking = false
  private readonly voice: VoiceDetector

  constructor(
    private readonly onChunk: (chunk: CutChunk) => void,
    /** Decides which frames are speech (Silero in main); without one, the energy detector does. */
    classifier: SpeechClassifier | null = null
  ) {
    this.voice = new VoiceDetector(
      {
        onStart: (frames, onset) => {
          this.heard.started = frames
          this.heard.onset = onset
          this.talking = true
        },
        onFrame: (_frame, voiced) => {
          this.heard.voiced = voiced
        },
        onEnd: () => {
          this.heard.ended = true
          this.talking = false
        }
      },
      classifier
    )
  }

  /**
   * One frame of 16 kHz audio starting at sample `at` of the session timeline. Speech is judged on
   * `analysis` (the frame levelled); the chunk keeps `frame` as it was.
   */
  push(frame: Float32Array, at: number, analysis: Float32Array = frame): void {
    const heard: Heard = { started: null, onset: 0, voiced: false, ended: false }
    this.heard = heard
    const level = this.voice.push(frame, analysis)
    this.next = at + frame.length

    let open = this.open
    if (open) {
      // A short fragment waiting for more keeps every frame, so what follows joins it seamlessly.
      open.frames.push(frame)
      open.levels.push(level)
      open.voiced.push(false)
      open.length += frame.length
    } else if (heard.started) {
      open = this.begin(heard.started)
    } else {
      return
    }
    // The onset frames came in before speech was declared, as silence (in the pre-roll, or in a
    // fragment still waiting): they are the chunk's newest frames, this one included.
    if (heard.started) markSpeech(open, heard.onset)
    if (heard.voiced) markSpeech(open, frame.length)

    if (heard.ended) {
      if (open.speech >= MIN_SPEECH) this.emit()
    } else if (!this.talking && open.length - open.speechEnd >= ORPHAN_WAIT) {
      this.emit()
    } else if (open.length >= MAX_CHUNK) {
      this.cutAtQuietest()
    }
  }

  /** Hands out whatever is still open (recording stopped), under the same rules as a pause. */
  flush(): void {
    this.voice.flush()
    this.emit()
  }

  /**
   * The earliest sample of this track not yet handed out in a chunk. That includes the voice
   * detector's pre-roll: the next chunk starts that far back, and lines on the other track must
   * not be released ahead of it.
   */
  pendingFrom(): number {
    return this.open?.start ?? this.next - this.voice.preRolled()
  }

  /** Opens a chunk on the voice detector's pre-roll, which ends with the latest frame. */
  private begin(frames: readonly Float32Array[]): Open {
    const length = frames.reduce((sum, part) => sum + part.length, 0)
    const open: Open = {
      start: this.next - length,
      frames: [...frames],
      levels: frames.map(rms),
      voiced: frames.map(() => false),
      length,
      speech: 0,
      speechEnd: 0
    }
    this.open = open
    return open
  }

  private emit(): void {
    const open = this.open
    this.open = null
    if (!open || open.speech < MIN_ORPHAN) return
    const length = Math.min(open.length, open.speechEnd + TAIL)
    this.onChunk({ start: open.start, pcm: concat(open.frames, length) })
  }

  /** A long stretch with no pause: cut where it's quietest, and keep going from there. */
  private cutAtQuietest(): void {
    const open = this.open
    if (!open) return
    let at = 0
    const ends: number[] = []
    for (const frame of open.frames) {
      at += frame.length
      ends.push(at)
    }
    let best = ends.length - 1
    let bestLevel = Infinity
    for (let i = 0; i < ends.length; i++) {
      const end = ends[i] ?? 0
      if (end < open.length - CUT_SEARCH || end >= open.length) continue
      let sum = 0
      for (let j = Math.max(0, i - CUT_SMOOTH + 1); j <= i; j++) sum += open.levels[j] ?? 0
      if (sum < bestLevel) {
        bestLevel = sum
        best = i
      }
    }
    const cut = best + 1
    const head = open.frames.slice(0, cut)
    const headLength = ends[best] ?? open.length
    // Cut mid-stretch, so the head is not trimmed: the rest carries on from its last sample.
    this.onChunk({ start: open.start, pcm: concat(head, headLength) })
    const rest: Open = {
      start: open.start + headLength,
      frames: open.frames.slice(cut),
      levels: open.levels.slice(cut),
      voiced: open.voiced.slice(cut),
      length: open.length - headLength,
      speech: 0,
      speechEnd: 0
    }
    // The rest keeps only the speech heard in it: a cut in the end pause leaves silence, which is
    // dropped unless more speech joins it.
    let offset = 0
    rest.frames.forEach((frame, i) => {
      offset += frame.length
      if (!rest.voiced[i]) return
      rest.speech += frame.length
      rest.speechEnd = offset
    })
    this.open = rest
  }
}

/** How far back the far end's level is remembered: its echo reaches the mic this much later. */
const ECHO_WINDOW = 10
/** Below this the far end is silent and can't be leaking into the mic. */
const FAR_ACTIVE = 0.004
/** The mic must be this many times louder than the far end's expected echo to be the user. */
const ECHO_MARGIN = 1.5
/** Before the echo path is measured, assume the speakers leak this much (laptop speakers). */
const DEFAULT_COUPLING = 0.8
/** Measurements kept (frames while the far end talks), about 30 s of it. */
const COUPLING_HISTORY = 900
const COUPLING_MIN_SAMPLES = 60
/** The share of far-end frames assumed to be the far end alone, without the user talking. */
const COUPLING_PERCENTILE = 0.3
/**
 * While the far end talks, the mic opens only after this many frames in a row above the echo,
 * and stays open this many frames after: a lone loud frame is the echo peaking, not the user.
 */
const OPEN_FRAMES = 3
const HOLD_FRAMES = 6
/** The coupling is re-measured this often (frames): sorting its history every frame is waste. */
const COUPLING_EVERY = 16

/**
 * Keeps what's left of the far end out of the mic track, after `EchoCanceller` has removed what
 * it can. On speakers the remote voice plays into the room, so it would be transcribed twice and
 * given to the user. The gate silences mic frames that are no louder than the echo expected from
 * what the system track just played. How much still leaks (the coupling) is measured as the call
 * goes, from the quieter mic frames while the far end talks: near zero on headphones, and once the
 * canceller has converged, so the user is rarely gated when talking over the far end.
 */
export class EchoGate {
  private readonly far: number[] = []
  private readonly near: number[] = []
  private readonly ratios: number[] = []
  private coupling = DEFAULT_COUPLING
  private gated = 0
  private frames = 0
  private above = 0
  private hold = 0
  private sinceLearned = 0
  /** Whether the latest frame was let through (the far end silent, or the mic above its echo). */
  passed = true

  /** The mic frame, or silence where it only holds the far end's echo. */
  apply(mic: Float32Array, system: Float32Array): Float32Array {
    this.frames++
    const near = rms(mic)
    this.far.push(rms(system))
    this.near.push(near)
    if (this.far.length > ECHO_WINDOW) this.far.shift()
    if (this.near.length > ECHO_WINDOW) this.near.shift()
    const far = Math.max(...this.far)
    if (far < FAR_ACTIVE) {
      this.above = 0
      this.hold = 0
      this.passed = true
      return mic
    }
    // Peaks over the same window, so the echo's delay and the gaps between syllables don't
    // make the speakers look quieter than they are.
    this.learn(Math.max(...this.near) / far)
    this.above = near >= far * this.coupling * ECHO_MARGIN ? this.above + 1 : 0
    if (this.above >= OPEN_FRAMES) this.hold = HOLD_FRAMES
    else if (this.hold > 0) this.hold--
    if (this.hold > 0) {
      this.passed = true
      return mic
    }
    this.passed = false
    this.gated++
    return new Float32Array(mic.length)
  }

  stats(): { coupling: number; gatedShare: number } {
    return { coupling: +this.coupling.toFixed(3), gatedShare: this.frames ? +(this.gated / this.frames).toFixed(3) : 0 }
  }

  private learn(ratio: number): void {
    this.ratios.push(ratio)
    if (this.ratios.length > COUPLING_HISTORY) this.ratios.shift()
    if (this.ratios.length < COUPLING_MIN_SAMPLES) return
    if (++this.sinceLearned < COUPLING_EVERY) return
    this.sinceLearned = 0
    const sorted = [...this.ratios].sort((a, b) => a - b)
    this.coupling = sorted[Math.floor(sorted.length * COUPLING_PERCENTILE)] ?? this.coupling
  }
}

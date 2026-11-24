import { rms, SAMPLE_RATE, VoiceDetector } from './vad'

/**
 * Cuts one track of a recording into chunks for whole-chunk transcription, the way WhisperX's
 * "cut and merge" does: a chunk ends at a pause, so no word straddles two chunks and nothing has
 * to overlap or be reconciled, and a long stretch without one is cut at its quietest moment
 * before Whisper's 30 s window. Context carries across chunks as text (Whisper's prompt), not
 * audio. Each chunk is contiguous audio from the session timeline, pauses included, so Whisper's
 * word times map straight back onto it.
 */

const MS = SAMPLE_RATE / 1000
/** A chunk with less speech than this waits for more rather than being transcribed alone. */
const MIN_SPEECH = 1000 * MS
/** …unless nothing follows it for this long ("Yes." and then quiet). */
const ORPHAN_WAIT = 3000 * MS
/** Speech shorter than this, with nothing after it, is a cough or a click: dropped. */
const MIN_ORPHAN = 300 * MS
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
  length: number
  speech: number
  /** Samples into the chunk where the latest speech ended. */
  speechEnd: number
  /** Samples of silence since the voice detector last heard speech end. */
  idle: number
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

/** What the voice detector said about the latest frame. */
type Heard = { started: Float32Array[] | null; speaking: boolean; ended: boolean }

export class PauseChunker {
  private open: Open | null = null
  private next = 0
  private heard: Heard = { started: null, speaking: false, ended: false }
  private readonly voice = new VoiceDetector({
    onStart: (frames) => {
      this.heard.started = frames
      this.heard.speaking = true
    },
    onFrame: () => {
      this.heard.speaking = true
    },
    onEnd: () => {
      this.heard.ended = true
    }
  })

  constructor(private readonly onChunk: (chunk: CutChunk) => void) {}

  /** One frame of 16 kHz audio starting at sample `at` of the session timeline. */
  push(frame: Float32Array, at: number): void {
    const heard: Heard = { started: null, speaking: false, ended: false }
    this.heard = heard
    const level = this.voice.push(frame)
    this.next = at + frame.length

    const { started } = heard
    if (!this.open && started) {
      // The voice detector's pre-roll ends with this frame.
      const length = started.reduce((sum, part) => sum + part.length, 0)
      this.open = {
        start: this.next - length,
        frames: [...started],
        levels: started.map(rms),
        length,
        speech: frame.length,
        speechEnd: length,
        idle: 0
      }
    } else if (this.open) {
      const open = this.open
      open.frames.push(frame)
      open.levels.push(level)
      open.length += frame.length
      if (heard.speaking) {
        open.speech += frame.length
        open.speechEnd = open.length
        open.idle = 0
      } else {
        open.idle += frame.length
      }
    }

    const open = this.open
    if (!open) return
    if (heard.ended) {
      if (open.speech >= MIN_SPEECH) this.emit()
    } else if (!heard.speaking && open.idle >= ORPHAN_WAIT) {
      this.emit()
    } else if (open.length >= MAX_CHUNK) {
      this.cutAtQuietest()
    }
  }

  /** Hands out whatever is still open (recording stopped). */
  flush(): void {
    this.voice.flush()
    this.emit()
  }

  /** The earliest sample of this track not yet handed out in a chunk. */
  pendingFrom(): number {
    return this.open?.start ?? this.next
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
    this.onChunk({ start: open.start, pcm: concat(head, headLength) })
    const rest = open.frames.slice(cut)
    this.open = {
      start: open.start + headLength,
      frames: rest,
      levels: open.levels.slice(cut),
      length: open.length - headLength,
      // Mid-speech: whatever is left counts as speech.
      speech: open.length - headLength,
      speechEnd: open.length - headLength,
      idle: 0
    }
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
/** A frame this loud on the mic, not gated, is the user's own speech. */
const OWN_RMS = 0.006

/**
 * Keeps the far end of a call out of the mic track. On speakers the remote voice plays into the
 * room and the mic hears it almost as loud as the system track, so it would be transcribed twice
 * and given to the user. The gate silences mic frames that are no louder than the echo expected
 * from what the system track just played. How much the speakers leak (the coupling) is measured
 * as the call goes, from the quieter mic frames while the far end talks: near zero on
 * headphones, so the user is never gated, and near one on laptop speakers.
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
  /** Whether the latest frame was the user's own speech (loud enough, and not the echo). */
  own = false

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
      this.own = near >= OWN_RMS
      return mic
    }
    // Peaks over the same window, so the echo's delay and the gaps between syllables don't
    // make the speakers look quieter than they are.
    this.learn(Math.max(...this.near) / far)
    this.above = near >= far * this.coupling * ECHO_MARGIN ? this.above + 1 : 0
    if (this.above >= OPEN_FRAMES) this.hold = HOLD_FRAMES
    else if (this.hold > 0) this.hold--
    if (this.hold > 0) {
      this.own = near >= OWN_RMS
      return mic
    }
    this.own = false
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
    const sorted = [...this.ratios].sort((a, b) => a - b)
    this.coupling = sorted[Math.floor(sorted.length * COUPLING_PERCENTILE)] ?? this.coupling
  }
}

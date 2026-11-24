import { EchoGate, PauseChunker, type CutChunk } from '../shared/audio/chunker'
import { SAMPLE_RATE } from '../shared/audio/vad'
import type { AudioTrack, TranscriptWord } from '../shared/types'
import { log } from './log'

/**
 * Transcribes a recording as it is captured, a whole chunk at a time. Each track is transcribed
 * on its own: on a call the mic is the person at this computer and the system track is everyone
 * else, so who said what is known from the track before any voiceprint, and crosstalk doesn't mix
 * two voices into one transcription. Chunks end at pauses (`PauseChunker`), so a chunk's text is
 * final the moment Whisper returns it; nothing is shown that might change.
 *
 * Results go out in the order their audio started, across both tracks, so lines land on the page
 * in time order even when a long chunk on one track finishes after a short one on the other.
 */

/** The capture worklet's frame size; the chunker works in these. */
const FRAME = 512
/** How much of a track's earlier text is Whisper's prompt for its next chunk. */
const CONTEXT_CHARS = 300
/**
 * A mic chunk with less of the user's own speech than this, on a call, is what slipped past the
 * echo gate: Whisper would invent words for it ("Hello? Hello?"), so it isn't transcribed.
 */
const MIN_OWN_SECONDS = 0.4
/** How long the mic's own-speech frames are remembered, enough for any chunk. */
const OWN_MEMORY_SECONDS = 60

export type Transcribe = (pcm: Float32Array, prompt: string) => Promise<TranscriptWord[]>

/** A transcribed chunk, its words on the session timeline (seconds). */
export type TranscribedChunk = {
  track: AudioTrack
  start: number
  end: number
  words: TranscriptWord[]
}

export type TranscriberProgress = {
  /** Chunks cut and waiting for (or in) Whisper. */
  queued: number
}

type Pending = { track: AudioTrack; start: number; result: TranscribedChunk | null }

type Lane = {
  track: AudioTrack
  chunker: PauseChunker
  /** Samples received but not yet fed to the chunker (waiting for the other track to catch up). */
  buffered: Float32Array[]
  bufferedLength: number
  /** Session-timeline sample of the first buffered sample. */
  at: number
  context: string
}

function take(lane: Lane, count: number): Float32Array {
  const out = new Float32Array(count)
  let written = 0
  while (written < count) {
    const head = lane.buffered[0]
    if (!head) break
    const part = head.subarray(0, count - written)
    out.set(part, written)
    written += part.length
    if (part.length === head.length) lane.buffered.shift()
    else lane.buffered[0] = head.subarray(part.length)
  }
  lane.bufferedLength -= written
  lane.at += written
  return out
}

function lastWords(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= CONTEXT_CHARS) return trimmed
  const tail = trimmed.slice(-CONTEXT_CHARS)
  return tail.slice(tail.indexOf(' ') + 1)
}

export class ChunkedTranscriber {
  private readonly lanes = new Map<AudioTrack, Lane>()
  private readonly gate: EchoGate | null
  private readonly pending: Pending[] = []
  /** Session-timeline samples where a mic frame of the user's own speech starts (calls only). */
  private readonly own: number[] = []
  private dropped = 0
  private work: Promise<void> = Promise.resolve()
  private failure: Error | null = null

  constructor(
    tracks: readonly AudioTrack[],
    /** Where this take starts on the session timeline, in samples. */
    start: number,
    private readonly transcribe: Transcribe,
    private readonly onChunk: (chunk: TranscribedChunk) => void,
    private readonly onProgress: (progress: TranscriberProgress) => void = () => undefined,
    /** Text before this recording (the session's title and transcript so far). */
    context = ''
  ) {
    for (const track of tracks) {
      const lane: Lane = {
        track,
        chunker: new PauseChunker((chunk) => {
          this.cut(lane, chunk)
        }),
        buffered: [],
        bufferedLength: 0,
        at: start,
        context
      }
      this.lanes.set(track, lane)
    }
    this.gate = this.lanes.has('system') ? new EchoGate() : null
  }

  /** Captured samples of one track, appended to what that track has had so far. */
  audio(track: AudioTrack, samples: Float32Array): void {
    const lane = this.lanes.get(track)
    if (!lane) return
    lane.buffered.push(samples)
    lane.bufferedLength += samples.length
    this.feed()
    this.release()
  }

  /** Cuts what's left, waits for every chunk, and hands out the rest. */
  async finish(): Promise<void> {
    this.feed(true)
    for (const lane of this.lanes.values()) lane.chunker.flush()
    await this.work
    this.release(true)
    if (this.failure) throw this.failure
  }

  progress(): TranscriberProgress {
    return { queued: this.pending.filter((entry) => !entry.result).length }
  }

  stats(): Record<string, number> {
    return { ...this.gate?.stats(), echoChunks: this.dropped, queued: this.pending.length }
  }

  /**
   * Feeds whole frames to the chunkers. With two tracks, a frame of the mic is fed only once the
   * system track's frame at the same time has arrived, so the echo gate compares like with like.
   */
  private feed(all = false): void {
    const mic = this.lanes.get('mic')
    const system = this.lanes.get('system')
    if (mic && system) {
      let frames = Math.floor(Math.min(mic.bufferedLength, system.bufferedLength) / FRAME)
      if (all) frames = Math.ceil(Math.max(mic.bufferedLength, system.bufferedLength) / FRAME)
      for (let i = 0; i < frames; i++) {
        const micAt = mic.at
        const systemAt = system.at
        const far = take(system, FRAME)
        const near = take(mic, FRAME)
        system.chunker.push(far, systemAt)
        if (this.gate) {
          const kept = this.gate.apply(near, far)
          if (this.gate.own) this.rememberOwn(micAt)
          mic.chunker.push(kept, micAt)
        } else {
          mic.chunker.push(near, micAt)
        }
      }
      return
    }
    for (const lane of this.lanes.values()) {
      const frames = all ? Math.ceil(lane.bufferedLength / FRAME) : Math.floor(lane.bufferedLength / FRAME)
      for (let i = 0; i < frames; i++) {
        const at = lane.at
        lane.chunker.push(take(lane, FRAME), at)
      }
    }
  }

  private rememberOwn(at: number): void {
    this.own.push(at)
    const forget = at - OWN_MEMORY_SECONDS * SAMPLE_RATE
    while ((this.own[0] ?? at) < forget) this.own.shift()
  }

  /** Seconds of the user's own speech on the mic in a chunk. */
  private ownSeconds(chunk: CutChunk): number {
    const end = chunk.start + chunk.pcm.length
    return (this.own.filter((at) => at >= chunk.start && at < end).length * FRAME) / SAMPLE_RATE
  }

  private cut(lane: Lane, chunk: CutChunk): void {
    if (lane.track === 'mic' && this.gate && this.ownSeconds(chunk) < MIN_OWN_SECONDS) {
      this.dropped++
      return
    }
    const entry: Pending = { track: lane.track, start: chunk.start / SAMPLE_RATE, result: null }
    this.pending.push(entry)
    this.pending.sort((a, b) => a.start - b.start)
    this.onProgress(this.progress())
    this.work = this.work.then(async () => {
      try {
        const words = await this.transcribe(chunk.pcm, lastWords(lane.context))
        const base = entry.start
        const limit = base + chunk.pcm.length / SAMPLE_RATE
        const placed = words.map((word) => ({
          text: word.text,
          start: +Math.min(word.start + base, limit).toFixed(3),
          end: +Math.min(word.end + base, limit).toFixed(3)
        }))
        lane.context = (lane.context + placed.map((word) => word.text).join('')).slice(-CONTEXT_CHARS * 2)
        entry.result = { track: lane.track, start: base, end: limit, words: placed }
      } catch (error) {
        // One bad chunk loses its words, not the recording.
        this.failure ??= error instanceof Error ? error : new Error(String(error))
        log('transcriber', 'chunk failed', { track: lane.track, start: entry.start, error: String(error) })
        entry.result = { track: lane.track, start: entry.start, end: entry.start, words: [] }
      }
      this.release()
      this.onProgress(this.progress())
    })
  }

  /** Hands out finished chunks that nothing earlier is still waiting on. */
  private release(all = false): void {
    const open = all ? Infinity : Math.min(...[...this.lanes.values()].map((lane) => lane.chunker.pendingFrom())) / SAMPLE_RATE
    for (;;) {
      const first = this.pending[0]
      if (!first?.result || first.start > open) break
      this.pending.shift()
      if (first.result.words.length) this.onChunk(first.result)
    }
  }
}

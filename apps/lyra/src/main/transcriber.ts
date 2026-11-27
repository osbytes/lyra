import { EchoCanceller } from '../shared/audio/aec'
import { EchoGate, PauseChunker, type CutChunk } from '../shared/audio/chunker'
import { LevelNormalizer } from '../shared/audio/level'
import { rms, SAMPLE_RATE, type SpeechClassifier } from '../shared/audio/vad'
import type { AudioTrack, TranscriptWord } from '../shared/types'
import { countBetween, ECHO_LEAD_SECONDS, FAR_ACTIVE_RMS, isEchoOnly } from './echoRule'
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
/** How long the mic's own-speech and far-end frames are remembered, enough for any chunk. */
const OWN_MEMORY_SECONDS = 60
/**
 * Seconds of audio waiting for Whisper past which the backlog is logged: Whisper is then running
 * slower than real time (a CPU fallback, a slow machine) and the text will trail the talk.
 */
const BACKLOG_WARN_SECONDS = 30
/** A levelled mic frame this loud, let through by the echo gate, is the user's own speech. */
const OWN_RMS = 0.006

export type Transcribe = (pcm: Float32Array, prompt: string) => Promise<TranscriptWord[]>

/** A transcribed chunk, its words on the session timeline (seconds). */
export type TranscribedChunk = {
  track: AudioTrack
  start: number
  end: number
  words: TranscriptWord[]
}

export type TranscriberOptions = {
  /** Text before this recording (the session's title and transcript so far). */
  context?: string
  /** A speech classifier per track (Silero); null falls back to the energy detector. */
  classifier?: () => SpeechClassifier | null
  /** Give Whisper a track's earlier text as its prompt (on unless an eval turns it off). */
  carryContext?: boolean
}

export type TranscriberProgress = {
  /** Chunks cut and waiting for (or in) Whisper. */
  queued: number
  /** Seconds of audio in those chunks. */
  queuedSeconds: number
}

/** Audio of a track not handed out as words yet, in seconds on the session timeline. */
export type UnfinishedSpan = { track: AudioTrack; start: number; end: number }

type Pending = { track: AudioTrack; start: number; seconds: number; result: TranscribedChunk | null }

type Lane = {
  track: AudioTrack
  chunker: PauseChunker
  /**
   * Levels what the voice detector judges. Whisper gets the audio unlevelled: it normalizes its
   * own input, and levelled audio cost it accuracy in the evals (gain steps between frames).
   */
  level: LevelNormalizer
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

function levelled(lane: Lane, frame: Float32Array): Float32Array {
  return lane.level.apply(frame, rms(frame))
}

function lastWords(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= CONTEXT_CHARS) return trimmed
  const tail = trimmed.slice(-CONTEXT_CHARS)
  return tail.slice(tail.indexOf(' ') + 1)
}

export class ChunkedTranscriber {
  private readonly lanes = new Map<AudioTrack, Lane>()
  private readonly carryContext: boolean
  private readonly canceller: EchoCanceller | null
  private readonly gate: EchoGate | null
  private readonly pending: Pending[] = []
  /** Session-timeline samples where a mic frame of the user's own speech starts (calls only). */
  private readonly own: number[] = []
  /** Session-timeline samples where a system frame with sound on it starts (calls only). */
  private readonly far: number[] = []
  private dropped = 0
  private peakQueued = 0
  private peakQueuedSeconds = 0
  private backlogWarned = false
  private work: Promise<void> = Promise.resolve()
  private failure: Error | null = null

  constructor(
    tracks: readonly AudioTrack[],
    /** Where this take starts on the session timeline, in samples. */
    private readonly start: number,
    private readonly transcribe: Transcribe,
    private readonly onChunk: (chunk: TranscribedChunk) => void,
    private readonly onProgress: (progress: TranscriberProgress) => void = () => undefined,
    options: TranscriberOptions = {}
  ) {
    const { context = '', classifier = () => null } = options
    this.carryContext = options.carryContext ?? true
    for (const track of tracks) {
      const lane: Lane = {
        track,
        chunker: new PauseChunker((chunk) => {
          this.cut(lane, chunk)
        }, classifier()),
        level: new LevelNormalizer(),
        buffered: [],
        bufferedLength: 0,
        at: start,
        context
      }
      this.lanes.set(track, lane)
    }
    const call = this.lanes.has('system')
    this.canceller = call ? new EchoCanceller() : null
    this.gate = call ? new EchoGate() : null
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
  /** Resolves once every chunk cut so far has been transcribed and handed out. */
  async settled(): Promise<void> {
    await this.work.catch(() => undefined)
  }

  async finish(): Promise<void> {
    this.feed(true)
    for (const lane of this.lanes.values()) lane.chunker.flush()
    await this.work
    this.release(true)
    if (this.failure) throw this.failure
  }

  progress(): TranscriberProgress {
    const waiting = this.pending.filter((entry) => !entry.result)
    const seconds = waiting.reduce((sum, entry) => sum + entry.seconds, 0)
    return { queued: waiting.length, queuedSeconds: +seconds.toFixed(1) }
  }

  /**
   * Per track, the audio from the first chunk not handed out yet to the end of what was received:
   * what a quit that couldn't wait for Whisper leaves untranscribed. Empty once all of it is out.
   */
  unfinished(): UnfinishedSpan[] {
    return [...this.lanes.values()].flatMap((lane) => {
      const from = this.handedOutTo(lane)
      const end = this.receivedTo(lane)
      return from < end ? [{ track: lane.track, start: +from.toFixed(3), end: +end.toFixed(3) }] : []
    })
  }

  /**
   * Per track, where the audio not handed out as words yet starts (where it ends if all of it
   * was). Saved while recording, so a crash leaves a mark of what to transcribe again: from there
   * to wherever the audio on disk ends.
   */
  handedOut(): { track: AudioTrack; at: number }[] {
    return [...this.lanes.values()].map((lane) => ({
      track: lane.track,
      at: +Math.min(this.handedOutTo(lane), this.receivedTo(lane)).toFixed(3)
    }))
  }

  private handedOutTo(lane: Lane): number {
    const waiting = this.pending.find((entry) => entry.track === lane.track)
    const from = Math.min(waiting?.start ?? Infinity, lane.chunker.pendingFrom() / SAMPLE_RATE)
    // Before its first frame a chunker says 0, not where the take starts: never before the take.
    return Math.max(this.start / SAMPLE_RATE, from)
  }

  private receivedTo(lane: Lane): number {
    return (lane.at + lane.bufferedLength) / SAMPLE_RATE
  }

  stats(): Record<string, number | boolean | null> {
    const levels = Object.fromEntries(
      [...this.lanes.values()].flatMap((lane) => {
        const { gainDb, speechDb } = lane.level.stats()
        return [
          [`${lane.track}GainDb`, gainDb],
          [`${lane.track}SpeechDb`, speechDb]
        ]
      })
    )
    const aec = this.canceller?.stats()
    return {
      ...this.gate?.stats(),
      ...(aec ? { aecErleDb: aec.erleDb, aecAdapted: aec.adapted, aecResets: aec.resets, aecCopies: aec.copies } : {}),
      ...levels,
      echoChunks: this.dropped,
      queued: this.pending.length,
      peakQueued: this.peakQueued,
      peakQueuedSeconds: +this.peakQueuedSeconds.toFixed(1)
    }
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
        if (rms(far) >= FAR_ACTIVE_RMS) this.remember(this.far, systemAt)
        system.chunker.push(far, systemAt, levelled(system, far))
        // Raw tracks in, so the canceller's model of the room is linear: echo removed, then what
        // the canceller missed gated, then levelled.
        const cleaned = this.canceller ? this.canceller.process(near, far) : near
        const kept = this.gate ? this.gate.apply(cleaned, far) : cleaned
        const level = levelled(mic, kept)
        if (this.gate?.passed && rms(level) >= OWN_RMS) this.remember(this.own, micAt)
        mic.chunker.push(kept, micAt, level)
      }
      return
    }
    for (const lane of this.lanes.values()) {
      const frames = all ? Math.ceil(lane.bufferedLength / FRAME) : Math.floor(lane.bufferedLength / FRAME)
      for (let i = 0; i < frames; i++) {
        const at = lane.at
        const frame = take(lane, FRAME)
        lane.chunker.push(frame, at, levelled(lane, frame))
      }
    }
  }

  private remember(frames: number[], at: number): void {
    frames.push(at)
    const forget = at - OWN_MEMORY_SECONDS * SAMPLE_RATE
    while ((frames[0] ?? at) < forget) frames.shift()
  }

  /**
   * On a call, a mic chunk that is only the far end's echo: little of the user's own speech while
   * the far end was playing. With the far end silent the chunk is kept however short it is.
   */
  private echoOnly(chunk: CutChunk): boolean {
    const end = chunk.start + chunk.pcm.length
    const seconds = (frames: number): number => (frames * FRAME) / SAMPLE_RATE
    const own = seconds(countBetween(this.own, chunk.start, end))
    const far = seconds(countBetween(this.far, chunk.start - ECHO_LEAD_SECONDS * SAMPLE_RATE, end))
    return isEchoOnly(own, far)
  }

  private cut(lane: Lane, chunk: CutChunk): void {
    if (lane.track === 'mic' && this.gate && this.echoOnly(chunk)) {
      this.dropped++
      return
    }
    const entry: Pending = {
      track: lane.track,
      start: chunk.start / SAMPLE_RATE,
      seconds: chunk.pcm.length / SAMPLE_RATE,
      result: null
    }
    this.pending.push(entry)
    this.pending.sort((a, b) => a.start - b.start)
    this.reportBacklog()
    this.work = this.work.then(async () => {
      try {
        const words = await this.transcribe(chunk.pcm, this.carryContext ? lastWords(lane.context) : '')
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
      this.reportBacklog()
    })
  }

  /** Reports the queue, keeps its peak for `stats()`, and logs when Whisper falls far behind. */
  private reportBacklog(): void {
    const progress = this.progress()
    this.peakQueued = Math.max(this.peakQueued, progress.queued)
    this.peakQueuedSeconds = Math.max(this.peakQueuedSeconds, progress.queuedSeconds)
    if (!this.backlogWarned && progress.queuedSeconds >= BACKLOG_WARN_SECONDS) {
      this.backlogWarned = true
      log('transcriber', 'falling behind', progress)
    } else if (this.backlogWarned && progress.queued === 0) {
      this.backlogWarned = false
      log('transcriber', 'caught up', { peakQueuedSeconds: +this.peakQueuedSeconds.toFixed(1) })
    }
    this.onProgress(progress)
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

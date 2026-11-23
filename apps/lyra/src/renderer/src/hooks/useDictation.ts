import { useCallback, useEffect, useRef, useState } from 'react'
import { openMicrophone, openSystemAudio, startCapture } from '../audio/capture'
import { SessionRecorder } from '../audio/sessionRecorder'
import { StreamingTranscriber } from '../audio/streaming'
import { SAMPLE_RATE, VoiceDetector } from '../audio/vad'
import type { RecordingKind, TranscriptWord } from '../../../shared/types'
import { log } from '../lib/log'
import { holdBackCommand } from '../text/transcript'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

type LevelListener = (level: number) => void

/** How often a diagnostic snapshot of the pipeline is logged while recording. */
const HEARTBEAT_MS = 3000

type Options = {
  /** Text that precedes the dictation (title + end of page), read when recording starts. */
  getContext: () => string
  /**
   * Called with each piece of confirmed text, in order, and roughly where it was said
   * (seconds on the session's timeline).
   */
  onCommit: (text: string, at: Span) => void
  /** Microphone to open, read when recording starts; `null` = system default. */
  getDeviceId: () => string | null
}

/** What to record: every session's audio is kept; a meeting can add the computer's audio. */
export type RecordOptions = { pageId: string; kind: RecordingKind; systemAudio: boolean }

export type Span = { start: number; end: number }

/**
 * The transcriber only hears speech (the voice detector drops silence), so its timestamps
 * skip the pauses. Each time speech starts, note where the transcriber's clock and the
 * recording's clock were, and map word times back onto the recording.
 */
class Timeline {
  private anchors: { heard: number; recorded: number }[] = []
  /** Where this recording starts on the session's timeline, in seconds. */
  offset = 0
  /** Samples of audio captured so far. */
  recorded = 0
  /** Samples fed to the transcriber so far. */
  heard = 0

  speechStarted(prerollSamples: number): void {
    this.anchors.push({ heard: this.heard, recorded: Math.max(0, this.recorded - prerollSamples) })
  }

  toRecording(seconds: number): number {
    const at = seconds * SAMPLE_RATE
    let anchor = this.anchors[0] ?? { heard: 0, recorded: 0 }
    for (const next of this.anchors) {
      if (next.heard > at) break
      anchor = next
    }
    return +(this.offset + (at - anchor.heard + anchor.recorded) / SAMPLE_RATE).toFixed(3)
  }
}

type Session = {
  stop: () => Promise<void>
}

function toBytes(pcm: Float32Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

function transcribe(pcm: Float32Array, prompt: string) {
  return window.api.transcribe(toBytes(pcm), prompt)
}

/**
 * Microphone → voice detector → streaming transcriber.
 *
 * Confirmed words are handed to `onCommit` as soon as Whisper is sure of them;
 * `live` holds the words it is still deciding on, for display as ghost text.
 */
export function useDictation({ getContext, onCommit, getDeviceId }: Options) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [live, setLive] = useState('')
  const [micName, setMicName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const session = useRef<Session | null>(null)
  const starting = useRef<{ cancelled: boolean } | null>(null)
  const levelListeners = useRef(new Set<LevelListener>())
  const options = useRef({ getContext, onCommit, getDeviceId })
  options.current = { getContext, onCommit, getDeviceId }

  const subscribeLevel = useCallback((listener: LevelListener) => {
    levelListeners.current.add(listener)
    return () => {
      levelListeners.current.delete(listener)
    }
  }, [])

  const start = useCallback(async (record: RecordOptions): Promise<void> => {
    if (session.current || starting.current) return
    // Stop can arrive while the model warms up; this lets it cancel the start.
    const attempt = { cancelled: false }
    starting.current = attempt
    // A function, so TypeScript doesn't assume the flag is unchanged across awaits.
    const cancelled = (): boolean => attempt.cancelled
    setError(null)
    setNotice(null)
    setLive('')
    setPhase('starting')

    // A trailing "new"/"next" is held until we know whether "paragraph" follows.
    let held = ''
    let tentative = ''
    const timeline = new Timeline()
    let lastSpan: Span = { start: 0, end: 0 }
    const onWords = (words: TranscriptWord[]): void => {
      const mapped = words.map((word) => ({
        text: word.text,
        start: timeline.toRecording(word.start),
        end: timeline.toRecording(word.end)
      }))
      const first = mapped[0]
      const last = mapped.at(-1)
      if (first && last) lastSpan = { start: first.start, end: last.end }
      window.api.appendRecordingWords(mapped)
    }
    const showLive = (): void => setLive(held + tentative)
    const fail = (caught: unknown): void => {
      log('dictation', 'error', String(caught))
      setError(caught instanceof Error ? caught.message : 'Transcription failed')
    }
    const commit = (text: string): void => {
      const [ready, rest] = holdBackCommand(held + text)
      held = rest
      if (ready) options.current.onCommit(ready, lastSpan)
      showLive()
    }
    const release = (): void => {
      if (held) options.current.onCommit(held, lastSpan)
      held = ''
      showLive()
    }

    try {
      // Open the mic and warm the model in parallel, but check for a cancel after each.
      const warm = window.api.warmUp()
      const { stream, usedFallback } = await openMicrophone(options.current.getDeviceId())
      const releaseMic = (): void => {
        stream.getTracks().forEach((track) => {
          track.stop()
        })
        log('dictation', 'start cancelled')
      }
      if (cancelled()) {
        releaseMic()
        void warm.catch(() => undefined)
        return
      }
      await warm
      if (cancelled()) {
        releaseMic()
        return
      }
      if (usedFallback) setNotice('Your chosen microphone isn’t available — using the default.')

      const system = record.systemAudio ? await openSystemAudio() : null
      if (cancelled()) {
        system?.getTracks().forEach((track) => {
          track.stop()
        })
        releaseMic()
        return
      }
      if (record.systemAudio && !system) {
        setNotice('Couldn’t capture computer audio — recording your microphone only.')
      }
      const activeRecorder = await SessionRecorder.start(record.pageId, system !== null, record.kind)
      timeline.offset = activeRecorder.offset
      const streamer = new StreamingTranscriber(
        transcribe,
        {
          onCommit: commit,
          onWords,
          onLive: (text) => {
            tentative = text
            showLive()
          },
          onError: fail
        },
        options.current.getContext()
      )
      const hear = (frame: Float32Array): void => {
        timeline.heard += frame.length
        streamer.append(frame)
      }
      const voice = new VoiceDetector({
        onStart: (frames) => {
          log('vad', 'speech started', voice.stats())
          timeline.speechStarted(frames.reduce((sum, frame) => sum + frame.length, 0))
          frames.forEach(hear)
        },
        onFrame: hear,
        onEnd: () => {
          log('vad', 'speech ended', voice.stats())
          void streamer.finalize().then(release, fail)
        }
      })

      let frames = 0
      let peak = 0
      let energy = 0
      const capture = await startCapture(
        stream,
        (frame) => {
          timeline.recorded += frame.length
          const rms = voice.push(frame)
          frames++
          peak = Math.max(peak, rms)
          energy += rms
          const level = Math.min(1, rms * 14)
          levelListeners.current.forEach((listener) => listener(level))
        },
        (reason) => {
          setError(reason)
          void stopRef.current()
        },
        {
          ...(system ? { system } : {}),
          onTracks: (mic: Float32Array, other: Float32Array | null) => {
            activeRecorder.push(mic, other)
          }
        }
      )

      // Expect ~31 frames a second; anything else means the microphone path is stalling.
      const expected = (HEARTBEAT_MS / 1000) * (16000 / 512)
      const heartbeat = setInterval(() => {
        const snapshot = {
          frames,
          peakRms: +peak.toFixed(4),
          meanRms: frames ? +(energy / frames).toFixed(4) : 0,
          ...voice.stats(),
          ...streamer.stats(),
          ...capture.state()
        }
        snapshot.noiseFloor = +snapshot.noiseFloor.toFixed(4)
        snapshot.onsetThreshold = +snapshot.onsetThreshold.toFixed(4)
        const stalled = frames < expected * 0.5 || snapshot.passMs > 8000
        log('dictation', stalled ? 'heartbeat (STALLED)' : 'heartbeat', snapshot)
        frames = peak = energy = 0
      }, HEARTBEAT_MS)

      session.current = {
        stop: async () => {
          clearInterval(heartbeat)
          capture.stop()
          voice.flush()
          levelListeners.current.forEach((listener) => listener(0))
          await streamer.idle()
          release()
          // After the last words, so they're saved with this recording.
          await activeRecorder.stop()
        }
      }
      setMicName(capture.micName)
      setPhase('listening')
      log('dictation', 'listening')
      // A stop that arrived while the audio graph was starting.
      if (cancelled()) void stopRef.current()
    } catch (caught) {
      log('dictation', 'failed to start', String(caught))
      fail(caught)
      setPhase('idle')
    } finally {
      if (starting.current === attempt) starting.current = null
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const current = session.current
    if (!current) {
      if (starting.current) {
        // Still warming up: give up on this start now rather than after the model loads.
        starting.current.cancelled = true
        starting.current = null
        setPhase('idle')
      }
      return
    }
    session.current = null
    log('dictation', 'stopping')
    setPhase('finishing')
    await current.stop()
    setLive('')
    setMicName('')
    setPhase('idle')
    log('dictation', 'stopped')
  }, [])
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => () => void session.current?.stop(), [])

  return {
    phase,
    recording: phase === 'listening' || phase === 'starting',
    live,
    micName,
    error,
    notice,
    start,
    stop,
    subscribeLevel
  }
}

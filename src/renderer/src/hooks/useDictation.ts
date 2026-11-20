import { useCallback, useEffect, useRef, useState } from 'react'
import { openMicrophone, openSystemAudio, startCapture } from '../audio/capture'
import { MeetingRecorder } from '../audio/meetingRecorder'
import { StreamingTranscriber } from '../audio/streaming'
import { VoiceDetector } from '../audio/vad'
import { log } from '../lib/log'
import { holdBackCommand } from '../text/transcript'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

type LevelListener = (level: number) => void

/** How often a diagnostic snapshot of the pipeline is logged while recording. */
const HEARTBEAT_MS = 3000

type Options = {
  /** Text that precedes the dictation (title + end of page), read when recording starts. */
  getContext: () => string
  /** Called with each piece of confirmed text, in order. */
  onCommit: (text: string) => void
  /** Microphone to open, read when recording starts; `null` = system default. */
  getDeviceId: () => string | null
}

/** Extra work for a meeting: record the audio to disk, optionally with system audio. */
export type MeetingOptions = { pageId: string; systemAudio: boolean }

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

  const start = useCallback(async (meeting?: MeetingOptions): Promise<void> => {
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
    const showLive = (): void => setLive(held + tentative)
    const fail = (caught: unknown): void => {
      log('dictation', 'error', String(caught))
      setError(caught instanceof Error ? caught.message : 'Transcription failed')
    }
    const commit = (text: string): void => {
      const [ready, rest] = holdBackCommand(held + text)
      held = rest
      if (ready) options.current.onCommit(ready)
      showLive()
    }
    const release = (): void => {
      if (held) options.current.onCommit(held)
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

      let system: MediaStream | null = null
      let recorder: MeetingRecorder | null = null
      if (meeting) {
        system = meeting.systemAudio ? await openSystemAudio() : null
        if (cancelled()) {
          system?.getTracks().forEach((track) => {
            track.stop()
          })
          releaseMic()
          return
        }
        if (meeting.systemAudio && !system) {
          setNotice('Couldn’t capture computer audio — recording your microphone only.')
        }
        recorder = await MeetingRecorder.start(meeting.pageId, system !== null)
      }
      const activeRecorder = recorder
      const streamer = new StreamingTranscriber(
        transcribe,
        {
          onCommit: commit,
          onLive: (text) => {
            tentative = text
            showLive()
          },
          onError: fail
        },
        options.current.getContext()
      )
      const voice = new VoiceDetector({
        onStart: (frames) => {
          log('vad', 'speech started', voice.stats())
          frames.forEach((frame) => streamer.append(frame))
        },
        onFrame: (frame) => streamer.append(frame),
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
          ...(activeRecorder
            ? {
                onTracks: (mic: Float32Array, other: Float32Array | null) => {
                  activeRecorder.push(mic, other)
                }
              }
            : {})
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
          await activeRecorder?.stop()
          voice.flush()
          levelListeners.current.forEach((listener) => listener(0))
          await streamer.idle()
          release()
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

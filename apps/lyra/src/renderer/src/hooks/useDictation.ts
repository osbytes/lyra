import { useCallback, useEffect, useRef, useState } from 'react'
import { openMicrophone, openSystemAudio, startCapture } from '../audio/capture'
import { SessionRecorder } from '../audio/sessionRecorder'
import { rms } from '../../../shared/audio/vad'
import type { TranscriptProgress } from '../../../shared/types'
import { log } from '../lib/log'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** Input levels, 0–1: the microphone, and the computer's audio when it's recorded. */
export type Levels = { mic: number; system: number | null }
type LevelListener = (levels: Levels) => void

/** How often a diagnostic snapshot of the pipeline is logged while recording. */
const HEARTBEAT_MS = 3000
/** A mic this quiet for this long is muted or disconnected, not just a quiet room. */
const SILENT_MIC_RMS = 0.0002
const SILENT_MIC_MS = 8000
const SILENT_MIC_NOTICE = 'Your microphone isn’t picking anything up. Check that it isn’t muted.'

type Options = {
  /** Microphone to open, read when recording starts; `null` = system default. */
  getDeviceId: () => string | null
}

/** What to record: the session's mic, and the computer's audio when that setting is on. */
export type RecordOptions = { pageId: string; systemAudio: boolean }

type Session = {
  stop: () => Promise<void>
}

const level = (samples: Float32Array): number => Math.min(1, rms(samples) * 14)

/**
 * Records a session: microphone (and computer audio) → main, which writes the audio and
 * transcribes it a chunk at a time at pauses (`src/main/transcriber.ts`). Nothing is transcribed
 * here and no unconfirmed text is shown: finished lines arrive in the session document, and
 * `progress` says whether speech is waiting to be transcribed.
 */
export function useDictation({ getDeviceId }: Options) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [micName, setMicName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<TranscriptProgress | null>(null)
  /** The session being recorded (or starting, or finishing), wherever the window has navigated. */
  const [pageId, setPageId] = useState<string | null>(null)

  const session = useRef<Session | null>(null)
  /** The session being recorded, until its last chunks are transcribed after a stop. */
  const recordingPage = useRef<string | null>(null)
  const starting = useRef<{ cancelled: boolean } | null>(null)
  const levelListeners = useRef(new Set<LevelListener>())
  const options = useRef({ getDeviceId })
  options.current = { getDeviceId }

  const subscribeLevel = useCallback((listener: LevelListener) => {
    levelListeners.current.add(listener)
    return () => {
      levelListeners.current.delete(listener)
    }
  }, [])

  useEffect(
    () =>
      window.api.onTranscriptProgress((next) => {
        if (next.pageId === recordingPage.current) setProgress(next)
      }),
    []
  )

  const start = useCallback(async (record: RecordOptions): Promise<void> => {
    if (session.current || starting.current) return
    // Stop can arrive while the model warms up; this lets it cancel the start.
    const attempt = { cancelled: false }
    starting.current = attempt
    // A function, so TypeScript doesn't assume the flag is unchanged across awaits.
    const cancelled = (): boolean => attempt.cancelled
    setError(null)
    setNotice(null)
    setProgress(null)
    setPageId(record.pageId)
    setPhase('starting')
    const fail = (caught: unknown): void => {
      log('dictation', 'error', String(caught))
      setError(caught instanceof Error ? caught.message : 'Recording failed')
    }

    try {
      // Open the mic and load the model in parallel (the first chunk needs it within seconds),
      // but check for a cancel after each.
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
      if (usedFallback) setNotice('Your chosen microphone isn’t available. Using the default.')

      const system = record.systemAudio ? await openSystemAudio() : null
      if (cancelled()) {
        system?.getTracks().forEach((track) => {
          track.stop()
        })
        releaseMic()
        return
      }
      if (record.systemAudio && !system) {
        setNotice('Couldn’t capture computer audio. Recording your microphone only.')
      }
      const activeRecorder = await SessionRecorder.start(record.pageId, system !== null)

      let frames = 0
      let peak = 0
      let systemPeak = 0
      let quietSince = Date.now()
      let warnedSilent = false
      const capture = await startCapture(
        stream,
        () => undefined,
        (reason) => {
          setError(reason)
          void stopRef.current()
        },
        {
          ...(system ? { system } : {}),
          onTracks: (mic: Float32Array, other: Float32Array | null) => {
            activeRecorder.push(mic, other)
            frames++
            const micRms = rms(mic)
            peak = Math.max(peak, micRms)
            if (other) systemPeak = Math.max(systemPeak, rms(other))
            const now = Date.now()
            if (micRms > SILENT_MIC_RMS) {
              quietSince = now
              if (warnedSilent) {
                warnedSilent = false
                setNotice((current) => (current === SILENT_MIC_NOTICE ? null : current))
              }
            } else if (!warnedSilent && now - quietSince > SILENT_MIC_MS) {
              warnedSilent = true
              setNotice(SILENT_MIC_NOTICE)
              log('dictation', 'mic silent')
            }
            const levels: Levels = { mic: level(mic), system: other ? level(other) : null }
            levelListeners.current.forEach((listener) => listener(levels))
          }
        }
      )

      // Expect ~31 frames a second; anything else means the microphone path is stalling.
      const expected = (HEARTBEAT_MS / 1000) * (16000 / 512)
      const heartbeat = setInterval(() => {
        const snapshot = {
          frames,
          peakRms: +peak.toFixed(4),
          systemPeakRms: +systemPeak.toFixed(4),
          ...capture.state()
        }
        const stalled = frames < expected * 0.5
        log('dictation', stalled ? 'heartbeat (STALLED)' : 'heartbeat', snapshot)
        frames = peak = systemPeak = 0
      }, HEARTBEAT_MS)

      recordingPage.current = record.pageId
      session.current = {
        stop: async () => {
          clearInterval(heartbeat)
          capture.stop()
          levelListeners.current.forEach((listener) => listener({ mic: 0, system: system ? 0 : null }))
          // Main transcribes what's left before this resolves.
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
      setPageId(null)
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
        setPageId(null)
        setPhase('idle')
      }
      return
    }
    session.current = null
    log('dictation', 'stopping')
    setPhase('finishing')
    await current.stop()
    recordingPage.current = null
    setProgress(null)
    setMicName('')
    setPageId(null)
    setPhase('idle')
    log('dictation', 'stopped')
  }, [])
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => () => void session.current?.stop(), [])

  return {
    phase,
    recording: phase === 'listening' || phase === 'starting',
    pageId,
    progress,
    micName,
    error,
    notice,
    start,
    stop,
    subscribeLevel
  }
}

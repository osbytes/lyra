import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  openMicrophone,
  openSystemAudio,
  startCapture,
  type CaptureEvent,
  type CaptureHandle
} from '../audio/capture'
import {
  nextStall,
  nextSystemAudio,
  type StallState,
  type SystemAudioChange,
  type SystemAudioState
} from '../audio/recovery'
import { SessionRecorder } from '../audio/sessionRecorder'
import { rms } from '../../../shared/audio/vad'
import type { TranscriptProgress } from '../../../shared/types'
import { log } from '../lib/log'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** How a `start` ended: recording, given up on by a stop, failed (see `error`), or not tried. */
export type StartResult = 'started' | 'cancelled' | 'failed' | 'busy'

/** Input levels, 0–1: the microphone, and the computer's audio when it's recorded. */
export type Levels = { mic: number; system: number | null }
type LevelListener = (levels: Levels) => void

/** How often a diagnostic snapshot of the pipeline is logged while recording. */
const HEARTBEAT_MS = 3000
/** A mic this quiet for this long is muted or disconnected, not just a quiet room. */
const SILENT_MIC_RMS = 0.0002
const SILENT_MIC_MS = 8000
/** How long "Reconnected to …" stays up. */
const RESTORED_NOTICE_MS = 8000
const SILENT_MIC_NOTICE = 'Your microphone isn’t picking anything up. Check that it isn’t muted.'
const NARROWBAND_NOTICE =
  'Your microphone is a headset in call mode, which lowers the quality of your voice and the computer’s audio. A built-in or wired mic transcribes better.'
const RECORDER_FAILED = 'Recording stopped: couldn’t write audio (is the disk full?)'
const STALLED_NOTICE =
  'Lyra isn’t receiving any audio, so nothing is being recorded. Try stopping and starting again, or choose another microphone.'

type Options = {
  /** Microphone to open, read when recording starts; `null` = system default. */
  getDeviceId: () => string | null
}

/** What to record: the session's mic, and the computer's audio when that setting is on. */
export type RecordOptions = { pageId: string; systemAudio: boolean }

/** One call to `start`; a stop while it's warming up sets `cancelled`. */
type Attempt = {
  pageId: string
  cancelled: boolean
  /** Settles once the attempt has let go of everything it opened. */
  done: Promise<void>
}

type Session = {
  /** The start that made this session: state is only reset by the stop of the newest one. */
  owner: Attempt
  stop: () => Promise<void>
  retrySystem: () => void
}

const level = (samples: Float32Array): number => Math.min(1, rms(samples) * 14)

const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught)

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    track.stop()
  })
}

/**
 * Records `work` as what a new start must wait for (a stop draining main's transcription, or a
 * cancelled start letting go of the mic), until it settles.
 */
function settleBefore(ref: RefObject<Promise<void> | null>, work: Promise<void>): Promise<void> {
  const tracked: Promise<void> = work.finally(() => {
    if (ref.current === tracked) ref.current = null
  })
  ref.current = tracked
  return tracked
}

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
  /**
   * Computer audio, apart from `notice`: a mic notice mustn't hide that the other side of a call
   * isn't being recorded. `systemHidden`: the user closed its message; the next change shows it.
   */
  const [systemAudio, setSystemAudio] = useState<SystemAudioState>('off')
  const [systemHidden, setSystemHidden] = useState(false)
  const [progress, setProgress] = useState<TranscriptProgress | null>(null)
  /** The session being recorded (or starting, or finishing), wherever the window has navigated. */
  const [pageId, setPageId] = useState<string | null>(null)

  const session = useRef<Session | null>(null)
  /** The session being recorded, until its last chunks are transcribed after a stop. */
  const recordingPage = useRef<string | null>(null)
  const starting = useRef<Attempt | null>(null)
  /** The newest start; an older start or stop that finishes late leaves the state alone. */
  const owner = useRef<Attempt | null>(null)
  /** A stop or a cancelled start still finishing; the next start waits for it. */
  const settling = useRef<Promise<void> | null>(null)
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

  const start = useCallback(async (record: RecordOptions): Promise<StartResult> => {
    // Main records one session at a time: a start that lands while the last recording is still
    // finishing waits for it rather than racing its cleanup.
    while (settling.current) await settling.current
    if (session.current || starting.current) return 'busy'
    let settle = (): void => undefined
    const attempt: Attempt = {
      pageId: record.pageId,
      cancelled: false,
      done: new Promise<void>((resolve) => {
        settle = resolve
      })
    }
    starting.current = attempt
    owner.current = attempt
    // A function, so TypeScript doesn't assume the flag is unchanged across awaits.
    const cancelled = (): boolean => attempt.cancelled
    setError(null)
    setNotice(null)
    setSystemAudio('off')
    setSystemHidden(false)
    setProgress(null)
    setPageId(record.pageId)
    setPhase('starting')

    let mic: MediaStream | null = null
    let system: MediaStream | null = null
    let recorder: SessionRecorder | null = null
    let capture: CaptureHandle | null = null
    /** Lets go of whatever this attempt opened: the mic light goes off and main's recorder stops. */
    const release = async (): Promise<void> => {
      capture?.stop()
      stopTracks(mic)
      stopTracks(system)
      if (recorder) {
        await recorder.stop().catch((caught: unknown) => {
          log('dictation', 'could not stop the recorder', errorText(caught))
        })
      }
    }
    const giveUp = async (): Promise<StartResult> => {
      await release()
      log('dictation', 'start cancelled')
      return 'cancelled'
    }

    try {
      // Open the mic and load the model in parallel (the first chunk needs it within seconds),
      // but check for a cancel after each.
      const warm = window.api.warmUp()
      // Awaited below; this keeps a start cancelled before then from an unhandled rejection.
      warm.catch(() => undefined)
      const opened = await openMicrophone(options.current.getDeviceId())
      mic = opened.stream
      if (cancelled()) return await giveUp()
      await warm
      if (cancelled()) return await giveUp()
      if (opened.usedFallback) setNotice('Your chosen microphone isn’t available. Using the default.')

      system = record.systemAudio ? await openSystemAudio() : null
      if (cancelled()) return await giveUp()
      const changeSystem = (change: SystemAudioChange): void => {
        if (owner.current !== attempt) return
        setSystemAudio((current) => nextSystemAudio(current, change))
        setSystemHidden(false)
      }
      // When it didn't open, the capture keeps a silent computer track and tries again.
      setSystemAudio(!record.systemAudio ? 'off' : system ? 'live' : 'retrying')
      if (record.systemAudio && !system) {
        // Why, when the OS can say: a refused permission has a settings page to send them to.
        window.api.permissionStatus().then(
          (status) => {
            if (status.screen !== 'granted') changeSystem('blocked')
          },
          () => {
            // The plain message stands.
          }
        )
      }
      recorder = await SessionRecorder.start(record.pageId, record.systemAudio)
      if (cancelled()) return await giveUp()
      const activeRecorder = recorder

      let frames = 0
      let peak = 0
      let systemPeak = 0
      let quietSince = Date.now()
      let warnedSilent = false
      let reconnecting = false
      let restoredTimer: ReturnType<typeof setTimeout> | null = null
      const onCaptureEvent = (event: CaptureEvent): void => {
        switch (event.type) {
          case 'mic-reconnecting': {
            reconnecting = true
            setNotice(`Lost ${event.micName}. Reconnecting…`)
            break
          }
          case 'mic-restored': {
            reconnecting = false
            quietSince = Date.now()
            setMicName(event.micName)
            const text = `Reconnected to ${event.micName}.`
            setNotice(text)
            if (restoredTimer) clearTimeout(restoredTimer)
            restoredTimer = setTimeout(() => {
              setNotice((current) => (current === text ? null : current))
            }, RESTORED_NOTICE_MS)
            break
          }
          case 'system-retrying': {
            changeSystem('retrying')
            break
          }
          case 'system-restored': {
            changeSystem('restored')
            break
          }
          case 'system-unavailable': {
            changeSystem('unavailable')
            break
          }
        }
      }
      const reopenMic = async (): Promise<MediaStream> =>
        (await openMicrophone(options.current.getDeviceId())).stream
      capture = await startCapture(
        mic,
        () => undefined,
        (reason) => {
          setError(reason)
          void stopRef.current()
        },
        {
          ...(record.systemAudio ? { system, reopenSystem: openSystemAudio } : {}),
          reopenMic,
          onEvent: onCaptureEvent,
          onTracks: (micFrame: Float32Array, other: Float32Array | null) => {
            activeRecorder.push(micFrame, other)
            frames++
            const micRms = rms(micFrame)
            peak = Math.max(peak, micRms)
            if (other) systemPeak = Math.max(systemPeak, rms(other))
            const now = Date.now()
            if (micRms > SILENT_MIC_RMS) {
              quietSince = now
              if (warnedSilent) {
                warnedSilent = false
                setNotice((current) => (current === SILENT_MIC_NOTICE ? null : current))
              }
            } else if (reconnecting) {
              // Silence while the mic is reopened is expected; the notice already says why.
              quietSince = now
            } else if (!warnedSilent && now - quietSince > SILENT_MIC_MS) {
              warnedSilent = true
              setNotice(SILENT_MIC_NOTICE)
              log('dictation', 'mic silent')
            }
            const levels: Levels = { mic: level(micFrame), system: other ? level(other) : null }
            levelListeners.current.forEach((listener) => {
              listener(levels)
            })
          }
        }
      )
      if (cancelled()) return await giveUp()
      const handle = capture

      // Expect ~31 frames a second; anything else means the microphone path is stalling.
      const expected = (HEARTBEAT_MS / 1000) * (16000 / 512)
      let stall: StallState = { stalls: 0, warned: false }
      const heartbeat = setInterval(() => {
        const snapshot = {
          frames,
          peakRms: +peak.toFixed(4),
          systemPeakRms: +systemPeak.toFixed(4),
          ...handle.state()
        }
        const stalled = frames < expected * 0.5
        log('dictation', stalled ? 'heartbeat (STALLED)' : 'heartbeat', snapshot)
        frames = peak = systemPeak = 0
        const next = nextStall(stall, stalled)
        stall = next.state
        if (next.recover) handle.recover()
        if (next.notice === 'show') {
          setNotice(STALLED_NOTICE)
          log('dictation', 'no audio arriving')
        } else if (next.notice === 'clear') {
          setNotice((current) => (current === STALLED_NOTICE ? null : current))
        }
      }, HEARTBEAT_MS)

      recordingPage.current = record.pageId
      session.current = {
        owner: attempt,
        stop: async () => {
          clearInterval(heartbeat)
          if (restoredTimer) clearTimeout(restoredTimer)
          handle.stop()
          levelListeners.current.forEach((listener) => {
            listener({ mic: 0, system: record.systemAudio ? 0 : null })
          })
          // Main transcribes what's left before this resolves.
          await activeRecorder.stop()
        },
        retrySystem: () => {
          handle.retrySystem()
        }
      }
      setMicName(handle.micName)
      if (handle.narrowband) setNotice((current) => current ?? NARROWBAND_NOTICE)
      setPhase('listening')
      log('dictation', 'listening')
      return 'started'
    } catch (caught) {
      await release()
      // A stop already reset the state; the error is just the cancelled work unwinding.
      if (cancelled()) return 'cancelled'
      log('dictation', 'failed to start', errorText(caught))
      if (owner.current === attempt) {
        setError(caught instanceof Error ? caught.message : 'Recording failed')
        setSystemAudio('off')
        setPageId(null)
        setPhase('idle')
      }
      return 'failed'
    } finally {
      if (starting.current === attempt) starting.current = null
      settle()
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const current = session.current
    if (!current) {
      const attempt = starting.current
      if (attempt) {
        // Still warming up: give up on this start now rather than after the model loads. The
        // next start waits until this one has closed the mic.
        attempt.cancelled = true
        starting.current = null
        setPageId(null)
        setPhase('idle')
        void settleBefore(settling, attempt.done)
      }
      // A stop pressed again while the last one finishes resolves when that one does.
      await settling.current
      return
    }
    session.current = null
    log('dictation', 'stopping')
    setPhase('finishing')
    const finish = async (): Promise<void> => {
      try {
        await current.stop()
      } catch (caught) {
        log('dictation', 'stop failed', errorText(caught))
        setError(`The recording stopped, but finishing its transcript failed: ${errorText(caught)}`)
      } finally {
        // A newer session (started once this one settled) owns the state from here.
        if (owner.current === current.owner) {
          recordingPage.current = null
          setProgress(null)
          setMicName('')
          setSystemAudio('off')
          setPageId(null)
          setPhase('idle')
        }
        log('dictation', 'stopped')
      }
    }
    await settleBefore(settling, finish())
  }, [])
  const stopRef = useRef(stop)
  stopRef.current = stop

  // Main stopped writing this recording's audio (a full disk, usually): stop capturing through
  // the normal stop path, then say why, over whatever the stop itself reported.
  useEffect(
    () =>
      window.api.onRecorderFailed((failure) => {
        const page = recordingPage.current ?? starting.current?.pageId ?? null
        if (failure.pageId !== page) return
        log('dictation', 'recorder failed', { track: failure.track })
        const failed = owner.current
        void stopRef.current().finally(() => {
          if (owner.current === failed) setError(RECORDER_FAILED)
        })
      }),
    []
  )

  useEffect(
    () => () => {
      if (starting.current) starting.current.cancelled = true
      void session.current?.stop()
    },
    []
  )

  /** Clears the error or notice the user closed; a later problem shows a new one. */
  const dismissMessage = useCallback(() => {
    setError(null)
    setNotice(null)
  }, [])

  /** The Retry on "Couldn't capture computer audio". */
  const retrySystemAudio = useCallback(() => {
    session.current?.retrySystem()
  }, [])
  const dismissSystemAudio = useCallback(() => {
    setSystemHidden(true)
  }, [])

  return {
    phase,
    recording: phase === 'listening' || phase === 'starting',
    pageId,
    progress,
    micName,
    error,
    notice,
    dismissMessage,
    systemAudio,
    systemAudioMessageShown: !systemHidden,
    retrySystemAudio,
    dismissSystemAudio,
    start,
    stop,
    subscribeLevel
  }
}

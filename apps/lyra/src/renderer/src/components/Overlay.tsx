import { useEffect, useRef, useState } from 'react'
import type { HotkeyStatus, MicPrompt, SessionState } from '../../../shared/types'
import { formatDuration } from '../lib/format'
import { displayAccelerator } from './HotkeyInput'
import { GripIcon, StopIcon } from './Icons'

/** Same as the dock's waveform in the main window. */
const BAR_COUNT = 20

function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 500)
    return () => {
      clearInterval(timer)
    }
  }, [running])
  return now
}

/** The session shortcut as the platform writes it, or null when none is registered. */
function useSessionHotkey(): string | null {
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([])
  useEffect(() => {
    const stop = window.api.onHotkeyStatus(setStatuses)
    window.api.getHotkeyStatus().then(setStatuses, () => {
      // No shortcut line then; the buttons still work.
    })
    return stop
  }, [])
  // The session shortcut is the only global one (HotkeyAction).
  const [session] = statuses
  return session?.registered ? displayAccelerator(session.accelerator) : null
}

function PromptCard({ prompt }: { prompt: MicPrompt }) {
  // The card never takes focus (it mustn't pull it from the call), so the global shortcut is the
  // keyboard's way in.
  const hotkey = useSessionHotkey()
  const who = prompt.app ? <strong>{prompt.app}</strong> : 'Another app'
  const meeting = prompt.kind === 'meeting'
  return (
    <div
      className="overlay-prompt"
      role="alertdialog"
      aria-label={meeting ? 'Record this meeting?' : 'Start a Lyra session?'}
    >
      {meeting ? (
        <p>
          A call started in {who}. Record it in Lyra, with the call’s audio?
        </p>
      ) : (
        <p>
          {who} is using your microphone. Record it in Lyra?
        </p>
      )}
      {hotkey ? (
        <p className="overlay-prompt-key">
          Or press <kbd>{hotkey}</kbd> to start a session.
        </p>
      ) : null}
      <div className="overlay-prompt-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            window.api.answerMicPrompt('start')
          }}
        >
          {meeting ? 'Record' : 'Start session'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            window.api.answerMicPrompt('dismiss')
          }}
        >
          {meeting ? 'Dismiss' : 'Not now'}
        </button>
        {prompt.app ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              window.api.answerMicPrompt('ignore')
            }}
          >
            Don’t ask for {prompt.app}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** The floating window: the recording pill, or the "mic in use" prompt. */
export function Overlay() {
  const [prompt, setPrompt] = useState<MicPrompt | null>(null)
  useEffect(() => window.api.onMicPrompt(setPrompt), [])
  return prompt ? <PromptCard prompt={prompt} /> : <RecordingPill />
}

/** The floating recording pill shown while Lyra's main window is out of view. */
function RecordingPill() {
  // `saved`: a recording just ended and the pill is staying a moment as the way back to Lyra.
  const [{ state, saved }, setView] = useState<{ state: SessionState | null; saved: boolean }>({
    state: null,
    saved: false
  })
  const [status, setStatus] = useState('')
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const stopButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Subscribe first, then fetch, so a change in between isn't lost.
    const stop = window.api.onSessionState((next) => {
      setView((current) => ({
        state: next,
        saved:
          next.phase === 'idle' &&
          (current.saved || current.state?.phase === 'listening' || current.state?.phase === 'finishing')
      }))
    })
    void window.api.getSessionState().then((initial) => {
      setView((current) => (current.state ? current : { state: initial, saved: false }))
    })
    return stop
  }, [])

  useEffect(() => {
    const history = new Array<number>(BAR_COUNT).fill(0)
    return window.api.onOverlayFrame((frame) => {
      setStatus(frame.status)
      history.shift()
      history.push(frame.level)
      history.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${String(0.12 + Math.min(1, value * 1.6) * 0.88)})`
      })
      stopButton.current?.style.setProperty('--level', String(Math.min(1, frame.level * 1.6)))
    })
  }, [])

  const listening = state?.phase === 'listening'
  const starting = state?.phase === 'starting'
  const now = useNow(listening)
  const elapsed = state?.startedAt ? Math.max(0, now - state.startedAt) : 0

  const label =
    state?.phase === 'starting'
      ? 'Warming up…'
      : state?.phase === 'finishing'
        ? 'Saving…'
        : status || 'Listening'

  if (saved) {
    return (
      <div className="overlay-pill">
        <span className="overlay-grip" aria-hidden="true">
          <GripIcon />
        </span>
        <button
          type="button"
          className="overlay-body overlay-saved"
          onClick={() => {
            window.api.showMainWindow()
          }}
        >
          <span className="dock-status">Recording saved</span>
          <span className="overlay-open">Open Lyra</span>
        </button>
      </div>
    )
  }

  // Laid out like the dock in the main window: stop on the left, then status, level and time.
  return (
    <div className={`overlay-pill${listening ? ' is-listening' : ''}`}>
      <span className="overlay-grip" aria-hidden="true">
        <GripIcon />
      </span>
      <button
        ref={stopButton}
        type="button"
        className="mic-btn overlay-stop"
        onClick={() => {
          window.api.requestStop()
        }}
        // A stop while warming up cancels the start (the model may still be downloading).
        disabled={!listening && !starting}
        aria-label={starting ? 'Cancel starting the recording' : 'Stop recording'}
      >
        <StopIcon />
      </button>
      <button
        type="button"
        className="overlay-body"
        onClick={() => {
          window.api.showMainWindow()
        }}
        aria-label={`${label}. Open Lyra`}
      >
        <span className="dock-status" aria-hidden="true">
          {label}
        </span>
        <span className="waveform" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                bars.current[i] = el
              }}
            />
          ))}
        </span>
        {/* Ticks twice a second; announcing it would drown everything else out. */}
        <span className="dock-timer" aria-hidden="true">
          {formatDuration(elapsed)}
        </span>
      </button>
    </div>
  )
}

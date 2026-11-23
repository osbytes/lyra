import { useEffect, useRef, useState } from 'react'
import type { MicPrompt, SessionState } from '../../../shared/types'
import { formatDuration } from '../lib/format'
import { GripIcon, StopIcon } from './Icons'

const BAR_COUNT = 16
const LIVE_CHARS = 60

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

function PromptCard({ prompt }: { prompt: MicPrompt }) {
  const who = prompt.app ? <strong>{prompt.app}</strong> : 'Another app'
  return (
    <div className="overlay-prompt" role="alertdialog" aria-label="Start a Lyra session?">
      <p>
        {who} is using your microphone. Record it in Lyra?
      </p>
      <div className="overlay-prompt-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            window.api.answerMicPrompt('start')
          }}
        >
          Start session
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            window.api.answerMicPrompt('dismiss')
          }}
        >
          Not now
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
  const [state, setState] = useState<SessionState | null>(null)
  const [live, setLive] = useState('')
  const bars = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    // Subscribe first, then fetch, so a change in between isn't lost.
    const stop = window.api.onSessionState(setState)
    void window.api.getSessionState().then((initial) => {
      setState((current) => current ?? initial)
    })
    return stop
  }, [])

  useEffect(() => {
    const history = new Array<number>(BAR_COUNT).fill(0)
    return window.api.onOverlayFrame((frame) => {
      setLive(frame.live)
      history.shift()
      history.push(frame.level)
      history.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${0.15 + Math.min(1, value * 1.6) * 0.85})`
      })
    })
  }, [])

  const listening = state?.phase === 'listening'
  const now = useNow(listening)
  const elapsed = state?.startedAt ? Math.max(0, now - state.startedAt) : 0
  const tail = live.length > LIVE_CHARS ? `…${live.slice(-LIVE_CHARS)}` : live

  const label =
    state?.phase === 'starting'
      ? 'Warming up…'
      : state?.phase === 'finishing'
        ? 'Saving…'
        : tail || 'Listening'

  return (
    <div className="overlay-pill" role="status">
      <span className="overlay-grip" title="Drag to move" aria-hidden="true">
        <GripIcon />
      </span>
      <button
        type="button"
        className="overlay-body"
        onClick={() => {
          window.api.showMainWindow()
        }}
        title="Open Lyra"
      >
        <span className={`overlay-dot${listening ? ' is-live' : ''}`} />
        <span className="overlay-time">{formatDuration(elapsed)}</span>
        <span className="overlay-bars" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                bars.current[i] = el
              }}
            />
          ))}
        </span>
        <span className="overlay-live">{label}</span>
      </button>
      <button
        type="button"
        className="overlay-stop"
        onClick={() => {
          window.api.requestStop()
        }}
        disabled={!listening}
        aria-label="Stop recording"
        title="Stop recording"
      >
        <StopIcon />
      </button>
    </div>
  )
}

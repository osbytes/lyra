import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WhisperStatus } from '../../../shared/types'
import type { DictationPhase } from '../hooks/useDictation'
import { useMicrophones } from '../hooks/useMicrophones'
import { formatDuration, shortcutLabel } from '../lib/format'
import { Floating, ScrollArea, Switch } from './Controls'
import { ChevronDownIcon, MicIcon, MicSmallIcon, SpeakerIcon, StopIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'

const BAR_COUNT = 28

type SubscribeLevel = (listener: (level: number) => void) => () => void

type Props = {
  phase: DictationPhase
  micName: string
  status: WhisperStatus
  error: string | null
  notice: string | null
  subscribeLevel: SubscribeLevel
  /** Starts or stops recording into the open session. */
  onToggle: () => void
  micDeviceId: string | null
  onMicChange: (deviceId: string | null) => void
  systemAudio: boolean
  onSystemAudioChange: (on: boolean) => void
  /** Narrow column (side panel open): sources show as icons only. */
  compact: boolean
  /** Banners and toasts that float above the dock. */
  children?: ReactNode
}

/**
 * Scrolling level history. Writes straight to the DOM so ~30 updates a second
 * never re-render React (or the editor).
 */
function Waveform({ subscribe }: { subscribe: SubscribeLevel }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const history = new Array<number>(BAR_COUNT).fill(0)
    return subscribe((level) => {
      history.shift()
      history.push(level)
      history.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${0.12 + Math.min(1, value * 1.6) * 0.88})`
      })
    })
  }, [subscribe])

  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </div>
  )
}

function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => clearInterval(timer)
  }, [running])
  return elapsed
}

function statusText(phase: DictationPhase, status: WhisperStatus): string {
  if (status.state === 'downloading') {
    const pct = status.total ? Math.round((status.received / status.total) * 100) : 0
    return `Downloading speech model… ${String(pct)}%`
  }
  if (phase === 'starting') return 'Warming up…'
  if (phase === 'finishing') return 'Finishing up…'
  if (phase === 'listening') return 'Listening'
  return 'Continue session'
}

/** What the session records, and a popover to change it (microphone, computer audio). */
function Sources({
  micDeviceId,
  onMicChange,
  systemAudio,
  onSystemAudioChange,
  compact,
  disabled
}: Pick<
  Props,
  'micDeviceId' | 'onMicChange' | 'systemAudio' | 'onSystemAudioChange' | 'compact'
> & {
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { microphones } = useMicrophones()
  const mic = micDeviceId
    ? microphones.find((entry) => entry.deviceId === micDeviceId)?.label
    : undefined
  const micLabel = mic ?? 'System mic'
  const summary = `${micLabel}${systemAudio ? ' and computer audio' : ''}`
  const rect = open ? anchor.current?.getBoundingClientRect() : undefined

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="dock-sources"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Recording: ${summary}. Change`}
        title={`Recording: ${summary}`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <MicSmallIcon />
        {compact ? null : <span className="dock-source-name">{micLabel}</span>}
        {systemAudio ? (
          <>
            <span className="dock-plus" aria-hidden="true">
              +
            </span>
            <SpeakerIcon />
            {compact ? null : <span>Computer</span>}
          </>
        ) : null}
        <ChevronDownIcon />
      </button>
      {open && rect ? (
        <Floating>
          <div className="picker-layer" onMouseDown={() => setOpen(false)}>
            <ScrollArea
              className="picker sources"
              role="dialog"
              aria-label="What to record"
              style={{
                bottom: window.innerHeight - rect.top + 8,
                left: Math.max(8, rect.right - 320)
              }}
              onMouseDown={(event) => {
                event.stopPropagation()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOpen(false)
                  anchor.current?.focus()
                }
              }}
            >
              <strong>What to record</strong>
              <div className="sources-row">
                <span>Microphone</span>
                <MicrophoneSelect value={micDeviceId} onChange={onMicChange} />
              </div>
              <div className="sources-row">
                <span className="sources-label">
                  Computer audio
                  <small>
                    The other side of calls. Speakers are labeled when there’s more than one.
                  </small>
                </span>
                <Switch
                  label="Record computer audio"
                  checked={systemAudio}
                  onChange={onSystemAudioChange}
                />
              </div>
            </ScrollArea>
          </div>
        </Floating>
      ) : null}
    </>
  )
}

export function DictationDock(props: Props) {
  const { phase, status, error, notice, subscribeLevel, onToggle } = props
  const listening = phase === 'listening'
  const busy = phase === 'starting' || phase === 'finishing'
  const elapsed = useElapsed(listening)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    return subscribeLevel((level) => {
      button.current?.style.setProperty('--level', String(Math.min(1, level * 1.6)))
    })
  }, [subscribeLevel])

  return (
    <div className="dock-area">
      {props.children}
      {error ? (
        <p className="dock-error" role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className="dock-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className={`dock${listening ? ' is-listening' : ''}`}>
        <button
          ref={button}
          type="button"
          className="mic-btn"
          onClick={onToggle}
          disabled={busy}
          aria-label={listening ? 'Stop recording' : 'Continue recording this session'}
          title={`${listening ? 'Stop' : 'Continue session'} (${shortcutLabel('D', true)})`}
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>

        <div className="dock-body">
          <span className="dock-status">{statusText(phase, status)}</span>
          {listening ? (
            <span className="dock-hint">Say “new paragraph” to break</span>
          ) : (
            <span className="dock-hint">
              Adds to the end · <kbd>{shortcutLabel('D', true)}</kbd>
            </span>
          )}
        </div>

        {listening ? (
          <>
            <Waveform subscribe={subscribeLevel} />
            <span className="dock-timer">{formatDuration(elapsed)}</span>
          </>
        ) : (
          <>
            <span className="dock-divider" aria-hidden="true" />
            <Sources
              micDeviceId={props.micDeviceId}
              onMicChange={props.onMicChange}
              systemAudio={props.systemAudio}
              onSystemAudioChange={props.onSystemAudioChange}
              compact={props.compact}
              disabled={busy}
            />
          </>
        )}
      </div>
    </div>
  )
}

'use client'

// A port of apps/lyra/src/renderer/src/components/DictationDock.tsx. The sources picker opens in
// place (the app floats it over the window) and lists the microphone without device access.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clock } from '@/lib/demo/time'
import { Switch } from './Controls'
import { ChevronDownIcon, MicIcon, MicSmallIcon, SpeakerIcon, StopIcon } from './Icons'
import type { DictationPhase } from './useScriptedDictation'

const BAR_COUNT = 28

type SubscribeLevel = (listener: (level: number) => void) => () => void

type Props = {
  phase: DictationPhase
  startedAt: number | null
  subscribeLevel: SubscribeLevel
  onToggle: () => void
  systemAudio: boolean
  onSystemAudioChange: (on: boolean) => void
  /** Narrow column (side panel open): sources show as icons only. */
  compact: boolean
  /** The app's shortcut label for the dock, e.g. `⇧⌘D`. */
  shortcut: string
  /** "Press to dictate", until the visitor first presses the mic. */
  hint: boolean
  /** Banners and toasts that float above the dock. */
  children?: ReactNode
}

/** Scrolling level history, written straight to the DOM so updates never re-render React. */
export function Waveform({ subscribe, bars = BAR_COUNT }: { subscribe: SubscribeLevel; bars?: number }) {
  const spans = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const history = new Array<number>(bars).fill(0)
    return subscribe((level) => {
      history.shift()
      history.push(level)
      history.forEach((value, i) => {
        const bar = spans.current[i]
        if (bar) bar.style.transform = `scaleY(${String(0.12 + Math.min(1, value * 1.6) * 0.88)})`
      })
    })
  }, [subscribe, bars])

  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            spans.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 250)
    return () => {
      clearInterval(timer)
    }
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, now - startedAt)
}

function statusText(phase: DictationPhase): string {
  if (phase === 'starting') return 'Warming up…'
  if (phase === 'finishing') return 'Finishing up…'
  if (phase === 'listening') return 'Listening'
  return 'Continue session'
}

function Sources({
  systemAudio,
  onSystemAudioChange,
  compact,
  disabled
}: Pick<Props, 'systemAudio' | 'onSystemAudioChange' | 'compact'> & { disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const summary = `System mic${systemAudio ? ' and computer audio' : ''}`

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!popover.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      anchor.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

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
        {compact ? null : <span className="dock-source-name">System mic</span>}
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
      {open ? (
        <div ref={popover} className="picker sources demo-sources" role="dialog" aria-label="What to record">
          <strong>What to record</strong>
          <div className="sources-row">
            <span>Microphone</span>
            <span className="demo-muted">System mic</span>
          </div>
          <div className="sources-row">
            <span className="sources-label">
              Computer audio
              <small>The other side of calls. Speakers are labeled when there’s more than one.</small>
            </span>
            <Switch label="Record computer audio" checked={systemAudio} onChange={onSystemAudioChange} />
          </div>
        </div>
      ) : null}
    </>
  )
}

export function DictationDock(props: Props) {
  const { phase, startedAt, subscribeLevel, onToggle, shortcut } = props
  const listening = phase === 'listening'
  const busy = phase === 'starting' || phase === 'finishing'
  const elapsed = useElapsed(startedAt)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(
    () =>
      subscribeLevel((level) => {
        button.current?.style.setProperty('--level', String(Math.min(1, level * 1.6)))
      }),
    [subscribeLevel]
  )

  return (
    <div className="dock-area">
      {props.children}
      <div className="dock-wrap">
        {props.hint ? <span className="try-hint">Press to dictate</span> : null}
        <div className={`dock${listening ? ' is-listening' : ''}`}>
          <button
            ref={button}
            type="button"
            className="mic-btn"
            onClick={onToggle}
            disabled={busy}
            aria-label={listening ? 'Stop recording' : 'Continue recording this session'}
            title={`${listening ? 'Stop' : 'Continue session'} (${shortcut})`}
          >
            {listening ? <StopIcon /> : <MicIcon />}
          </button>

          <div className="dock-body">
            <span className="dock-status">{statusText(phase)}</span>
            {listening ? (
              <span className="dock-hint">Say “new paragraph” to break</span>
            ) : (
              <span className="dock-hint">
                Adds to the end · <kbd>{shortcut}</kbd>
              </span>
            )}
          </div>

          {listening ? (
            <>
              <Waveform subscribe={subscribeLevel} />
              <span className="dock-timer">{clock(elapsed / 1000)}</span>
            </>
          ) : (
            <>
              <span className="dock-divider" aria-hidden="true" />
              <Sources
                systemAudio={props.systemAudio}
                onSystemAudioChange={props.onSystemAudioChange}
                compact={props.compact}
                disabled={busy}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

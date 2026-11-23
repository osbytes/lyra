import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { WhisperStatus } from '../../../shared/types'
import type { DictationPhase } from '../hooks/useDictation'
import { useMicrophones } from '../hooks/useMicrophones'
import { formatDuration, shortcutLabel } from '../lib/format'
import { Floating, ScrollArea, Switch } from './Controls'
import { ChevronDownIcon, GripIcon, MicIcon, MicSmallIcon, SpeakerIcon, StopIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'

const BAR_COUNT = 20
const OFFSET_KEY = 'lyra.dockOffset'
/** Space kept between the dock and the edges of the column it floats in. */
const EDGE = 8
/** Height the sources popover needs above the dock before it opens below instead. */
const POPOVER_ROOM = 260

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
  // Idle: the mic button's tooltip says what it does.
  return ''
}

/** What the session records, and a popover to change it (microphone, computer audio). */
function Sources({
  micDeviceId,
  onMicChange,
  systemAudio,
  onSystemAudioChange,
  disabled
}: Pick<Props, 'micDeviceId' | 'onMicChange' | 'systemAudio' | 'onSystemAudioChange'> & {
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
        {systemAudio ? (
          <>
            <span className="dock-plus" aria-hidden="true">
              +
            </span>
            <SpeakerIcon />
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
                ...(rect.top < POPOVER_ROOM
                  ? { top: rect.bottom + 8 }
                  : { bottom: window.innerHeight - rect.top + 8 }),
                left: Math.min(window.innerWidth - 328, Math.max(8, rect.right - 320))
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

type Offset = { x: number; y: number }

function readOffset(): Offset {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OFFSET_KEY) ?? 'null')
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'x' in raw &&
      'y' in raw &&
      typeof raw.x === 'number' &&
      typeof raw.y === 'number'
    ) {
      return { x: raw.x, y: raw.y }
    }
  } catch {
    // A corrupt value just means the default spot.
  }
  return { x: 0, y: 0 }
}

function onButton(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button') !== null
}

/**
 * Lets the dock be dragged anywhere in the column it floats in. The offset moves the whole dock
 * area, so banners and toasts travel with it, and is remembered across launches.
 */
function useDockDrag() {
  const area = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const offset = useRef<Offset>(readOffset())
  const [dragging, setDragging] = useState(false)
  const [nearTop, setNearTop] = useState(false)

  /** Keeps the dock inside its column and applies the offset straight to the DOM. */
  const apply = useCallback((next: Offset) => {
    const areaEl = area.current
    const dockEl = dock.current
    const bounds = areaEl?.offsetParent?.getBoundingClientRect()
    if (!areaEl || !dockEl || !bounds) return
    const rect = dockEl.getBoundingClientRect()
    const homeLeft = rect.left - offset.current.x
    const homeTop = rect.top - offset.current.y
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(Math.max(value, min), Math.max(min, max))
    const x = clamp(
      next.x,
      bounds.left + EDGE - homeLeft,
      bounds.right - EDGE - rect.width - homeLeft
    )
    const y = clamp(
      next.y,
      bounds.top + EDGE - homeTop,
      bounds.bottom - EDGE - rect.height - homeTop
    )
    offset.current = { x, y }
    areaEl.style.transform = x || y ? `translate(${String(x)}px, ${String(y)}px)` : ''
    setNearTop(homeTop + y - bounds.top < bounds.height / 2)
  }, [])

  useEffect(() => {
    const parent = area.current?.offsetParent
    apply(offset.current)
    if (!parent) return
    // The column changes size with the window and the side panel.
    const observer = new ResizeObserver(() => {
      apply(offset.current)
    })
    observer.observe(parent)
    return () => {
      observer.disconnect()
    }
  }, [apply])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || onButton(event.target)) return
    const target = event.currentTarget
    const start = { x: event.clientX, y: event.clientY, offset: offset.current }
    target.setPointerCapture(event.pointerId)
    setDragging(true)
    const move = (e: PointerEvent): void => {
      apply({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y })
    }
    const end = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      setDragging(false)
      localStorage.setItem(OFFSET_KEY, JSON.stringify(offset.current))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
    event.preventDefault()
  }

  const reset = (event: ReactMouseEvent): void => {
    if (onButton(event.target)) return
    offset.current = { x: 0, y: 0 }
    apply(offset.current)
    localStorage.removeItem(OFFSET_KEY)
  }

  return { area, dock, dragging, nearTop, onPointerDown, reset }
}

export function DictationDock(props: Props) {
  const { phase, status, error, notice, subscribeLevel, onToggle } = props
  const listening = phase === 'listening'
  const busy = phase === 'starting' || phase === 'finishing'
  const elapsed = useElapsed(listening)
  const button = useRef<HTMLButtonElement>(null)
  const drag = useDockDrag()
  const label = statusText(phase, status)

  useEffect(() => {
    return subscribeLevel((level) => {
      button.current?.style.setProperty('--level', String(Math.min(1, level * 1.6)))
    })
  }, [subscribeLevel])

  return (
    <div ref={drag.area} className={`dock-area${drag.nearTop ? ' is-top' : ''}`}>
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

      <div
        ref={drag.dock}
        className={`dock${listening ? ' is-listening' : ''}${drag.dragging ? ' is-dragging' : ''}`}
        onPointerDown={drag.onPointerDown}
        onDoubleClick={drag.reset}
      >
        <span className="dock-grip" title="Drag to move · double-click to reset" aria-hidden="true">
          <GripIcon />
        </span>
        <button
          ref={button}
          type="button"
          className="mic-btn"
          onClick={onToggle}
          disabled={busy}
          aria-label={listening ? 'Stop recording' : 'Continue recording this session'}
          title={`${listening ? 'Stop' : 'Continue session · adds to the end'} (${shortcutLabel('D', true)})`}
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>

        {label ? (
          <span
            className="dock-status"
            title={listening ? 'Say “new paragraph” to break' : undefined}
          >
            {label}
          </span>
        ) : null}

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
              disabled={busy}
            />
          </>
        )}
      </div>
    </div>
  )
}

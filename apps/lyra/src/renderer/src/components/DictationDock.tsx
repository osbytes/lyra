import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { SYSTEM_AUDIO_BLOCKED_NOTICE, type DictationPhase, type Levels } from '../hooks/useDictation'
import { notify } from '../lib/toast'
import { useMicrophones } from '../hooks/useMicrophones'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { formatDuration, shortcutLabel } from '../lib/format'
import { DOCK_LABELS, dockLabel, phaseAnnouncement } from '../lib/status'
import { Floating, ScrollArea, Switch } from './Controls'
import { ChevronDownIcon, GripIcon, MicIcon, MicSmallIcon, SpeakerIcon, StopIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'
import { Toast } from './ToastStack'
import { tip } from './Tooltip'

const BAR_COUNT = 20
/** Bars in each of the two meters shown while recording a call. */
const METER_BARS = 10
const OFFSET_KEY = 'lyra.dockOffset'
/** Space kept between the dock and the edges of the column it floats in. */
const EDGE = 8
/** Height the sources popover needs above the dock before it opens below instead. */
const POPOVER_ROOM = 260

type SubscribeLevel = (listener: (levels: Levels) => void) => () => void

type Props = {
  phase: DictationPhase
  micName: string
  subscribeLevel: SubscribeLevel
  /** Speech is waiting to be transcribed. */
  transcribing: boolean
  /** Starts or stops recording into the open session (or stops the one recording elsewhere). */
  onToggle: () => void
  /** When the recording began (ms since epoch), so the timer survives switching sessions. */
  startedAt: number | null
  /** Recording a session other than the open one: its title, and a way back to it. */
  elsewhere: { title: string; onShow: () => void } | null
  micDeviceId: string | null
  onMicChange: (deviceId: string | null) => void
  systemAudio: boolean
  onSystemAudioChange: (on: boolean) => void
}

/**
 * Scrolling level history of one input. Writes straight to the DOM so ~30 updates a second
 * never re-render React (or the editor).
 */
function Waveform({
  subscribe,
  track,
  label,
  count = BAR_COUNT
}: {
  subscribe: SubscribeLevel
  track: keyof Levels
  label: string
  count?: number
}) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const history = new Array<number>(count).fill(0)
    return subscribe((levels) => {
      history.shift()
      history.push(levels[track] ?? 0)
      history.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${0.12 + Math.min(1, value * 1.6) * 0.88})`
      })
    })
  }, [subscribe, track, count])

  return (
    <div className={`waveform is-${track}`} {...tip(label)}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </div>
  )
}

/** Both inputs' levels while recording a call: you on the mic, the other side on the computer. */
function Meters({ subscribe, systemAudio }: { subscribe: SubscribeLevel; systemAudio: boolean }) {
  return systemAudio ? (
    <span className="dock-meters">
      <span className="dock-meter">
        <MicSmallIcon />
        <Waveform subscribe={subscribe} track="mic" label="Your microphone" count={METER_BARS} />
      </span>
      <span className="dock-meter">
        <SpeakerIcon />
        <Waveform subscribe={subscribe} track="system" label="Computer audio" count={METER_BARS} />
      </span>
    </span>
  ) : (
    <Waveform subscribe={subscribe} track="mic" label="Your microphone" />
  )
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, now - startedAt)
}

/**
 * The dock's status word. Every possible word sits in the same grid cell, hidden but for the
 * current one, so the slot keeps the width of the longest and the dock never shifts.
 */
function DockStatus({ label, hint }: { label: string; hint: boolean }) {
  return (
    <span className="dock-status" {...(hint ? tip('Say “new paragraph” to break') : {})}>
      {DOCK_LABELS.map((word) => (
        <span
          key={word}
          aria-hidden={word !== label}
          className={word === label ? undefined : 'is-sizer'}
        >
          {word}
        </span>
      ))}
    </span>
  )
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
  const popover = useRef<HTMLElement>(null)
  const { microphones } = useMicrophones()
  const mic = micDeviceId
    ? microphones.find((entry) => entry.deviceId === micDeviceId)?.label
    : undefined
  const micLabel = mic ?? 'System mic'
  const summary = `${micLabel}${systemAudio ? ' and computer audio' : ''}`
  const rect = open ? anchor.current?.getBoundingClientRect() : undefined

  const shown = open && rect !== undefined
  useDialogFocus(popover, shown)

  // Escape is heard document-wide, wherever focus is in the popover. A nested dropdown that
  // handled Escape itself has already prevented it and closes alone.
  useHotkeys(
    'escape',
    () => {
      setOpen(false)
      anchor.current?.focus()
    },
    {
      enabled: open,
      enableOnFormTags: true,
      preventDefault: true,
      ignoreEventWhen: (event) => event.defaultPrevented
    }
  )

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="dock-sources"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Recording: ${summary}. Change`}
        {...tip(`Recording: ${summary}`)}
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
              ref={popover}
              className="picker sources"
              role="dialog"
              aria-modal="true"
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
    const target = event.currentTarget
    // Popovers render in a portal, but React still bubbles their events here: only the dock's
    // own DOM starts a drag, or the whole backdrop would become a drag handle.
    if (!(event.target instanceof Node) || !target.contains(event.target)) return
    if (event.button !== 0 || onButton(event.target)) return
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

/** The latest phase change to announce; stays put (and so silent) until the next change. */
function usePhaseAnnouncement(phase: DictationPhase): string {
  const [said, setSaid] = useState({ phase, text: '' })
  if (said.phase !== phase) {
    // Adjusting state from the last render's phase, as React recommends over an effect.
    setSaid({ phase, text: phaseAnnouncement(said.phase, phase) ?? said.text })
  }
  return said.text
}

export function DictationDock(props: Props) {
  const { phase, subscribeLevel, transcribing, onToggle, elsewhere } = props
  const listening = phase === 'listening'
  const starting = phase === 'starting'
  const busy = starting || phase === 'finishing'
  const elapsed = useElapsed(listening ? props.startedAt : null)
  const button = useRef<HTMLButtonElement>(null)
  const drag = useDockDrag()
  const label = dockLabel(phase, transcribing)
  const announcement = usePhaseAnnouncement(phase)

  useEffect(() => {
    return subscribeLevel((levels) => {
      const level = Math.max(levels.mic, levels.system ?? 0)
      button.current?.style.setProperty('--level', String(Math.min(1, level * 1.6)))
    })
  }, [subscribeLevel])

  return (
    <div ref={drag.area} className={`dock-area${drag.nearTop ? ' is-top' : ''}`}>
      {/* Says when recording starts and stops; the status text beside the button isn't read. */}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>

      <div
        ref={drag.dock}
        className={`dock${listening ? ' is-listening' : ''}${drag.dragging ? ' is-dragging' : ''}`}
        onPointerDown={drag.onPointerDown}
        onDoubleClick={drag.reset}
      >
        <span className="dock-grip" {...tip('Drag to move · double-click to reset')} aria-hidden="true">
          <GripIcon />
        </span>
        <button
          ref={button}
          type="button"
          className="mic-btn"
          onClick={onToggle}
          // Warming up can take a while (the model may be downloading), so it can be cancelled.
          disabled={phase === 'finishing'}
          aria-label={
            starting
              ? 'Cancel starting the recording'
              : listening
                ? elsewhere
                  ? `Stop recording “${elsewhere.title}”`
                  : 'Stop recording'
                : 'Continue recording this session'
          }
          {...tip(
            starting
              ? 'Cancel'
              : listening
                ? elsewhere
                  ? `Stop recording “${elsewhere.title}”`
                  : 'Stop'
                : 'Continue session · adds to the end',
            shortcutLabel('D', true)
          )}
        >
          {listening || starting ? <StopIcon /> : <MicIcon />}
        </button>

        {label ? <DockStatus label={label} hint={listening} /> : null}

        {elsewhere && (listening || busy) ? (
          <button
            type="button"
            className="dock-elsewhere"
            onClick={elsewhere.onShow}
            {...tip('Go to the session being recorded')}
          >
            {elsewhere.title}
          </button>
        ) : null}

        {listening ? (
          <>
            <Meters subscribe={subscribeLevel} systemAudio={props.systemAudio} />
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

/** The recorder's error or notice, shown in the toast stack rather than on the dock. */
export function DictationMessage({
  error,
  notice,
  onDismiss
}: {
  error: string | null
  notice: string | null
  onDismiss: () => void
}) {
  if (error) return <Toast tone="error" role="alert" text={error} onDismiss={onDismiss} />
  if (!notice) return null
  return (
    <Toast
      text={notice}
      onDismiss={onDismiss}
      action={
        notice === SYSTEM_AUDIO_BLOCKED_NOTICE ? (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              window.api.openPermissionSettings('screen').then(
                (opened) => {
                  if (!opened) notify('Open your system settings to change this.')
                },
                () => {
                  notify('Couldn’t open system settings.')
                }
              )
            }}
          >
            Open Settings
          </button>
        ) : null
      }
    />
  )
}

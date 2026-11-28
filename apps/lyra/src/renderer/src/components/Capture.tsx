import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SystemAudioState } from '../audio/recovery'
import type { DictationPhase, Levels } from '../hooks/useDictation'
import { shortcutLabel } from '../lib/format'
import { phaseAnnouncement } from '../lib/status'
import { notify } from '../lib/toast'
import { MicIcon, RecordIcon, SpeakerIcon, StopIcon } from './Icons'
import { Toast } from './ToastStack'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { Spinner } from './ui/status'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

export type SubscribeLevel = (listener: (levels: Levels) => void) => () => void

/** The latest phase change to announce; stays put (and so silent) until the next change. */
function usePhaseAnnouncement(phase: DictationPhase): string {
  const [said, setSaid] = useState({ phase, text: '' })
  if (said.phase !== phase) {
    // Adjusting state from the last render's phase, as React recommends over an effect.
    setSaid({ phase, text: phaseAnnouncement(said.phase, phase) ?? said.text })
  }
  return said.text
}

type RecordProps = {
  phase: DictationPhase
  /** This session already has something in it, so recording continues it. */
  continues: boolean
  systemAudio: boolean
  onSystemAudioChange: (on: boolean) => void
  onToggle: () => void
  /** Another session is being recorded. */
  elsewhere: { title: string; onShow: () => void } | null
  size?: 'lg' | 'sm'
  /** Shown beside Stop while this session records: the time and the levels. */
  readout?: ReactNode
}

/**
 * The record control, in the session header: one button whose label and icon change and whose
 * position never moves. Idle: a hollow ring, "Record" (or "Record more"). Starting: a dashed
 * ring, cancellable. Listening: red, a solid square, "Stop". Finishing: a spinner. Beside it the
 * source, mic or mic and computer audio, locked while listening.
 */
export function RecordControl({
  phase,
  continues,
  systemAudio,
  onSystemAudioChange,
  onToggle,
  elsewhere,
  size = 'lg',
  readout
}: RecordProps) {
  const announcement = usePhaseAnnouncement(phase)
  const listening = phase === 'listening' && !elsewhere
  const starting = phase === 'starting' && !elsewhere
  const finishing = phase === 'finishing' && !elsewhere
  const busy = phase !== 'idle'
  return (
    <span className="record-control flex items-center gap-2">
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
      {elsewhere && busy ? (
        <Button size={size} variant="ghost" className="no-drag max-w-[220px]" onClick={elsewhere.onShow} {...tip('Go to the session being recorded')}>
          <span className="inline-block size-2 shrink-0 rounded-full bg-record live-pulse" aria-hidden="true" />
          <span className="truncate">Recording “{elsewhere.title}”</span>
        </Button>
      ) : null}
      <Button
        size={size}
        variant={listening || (elsewhere && phase === 'listening') ? 'record' : 'secondary'}
        className="no-drag"
        disabled={finishing}
        onClick={onToggle}
        aria-label={
          starting
            ? 'Cancel starting the recording'
            : elsewhere && busy
              ? `Stop recording “${elsewhere.title}”`
              : listening
                ? 'Stop recording'
                : continues
                  ? 'Record more into this session'
                  : 'Record'
        }
        {...tip(
          starting ? 'Cancel' : listening || (elsewhere && busy) ? 'Stop' : continues ? 'Record more · adds to the end' : 'Record',
          shortcutLabel('D', true)
        )}
      >
        {finishing ? (
          <Spinner />
        ) : listening || (elsewhere && busy) ? (
          <StopIcon />
        ) : starting ? (
          <RecordIcon className="text-record [&_circle]:[stroke-dasharray:3_2]" />
        ) : (
          <RecordIcon className="text-record" />
        )}
        {finishing
          ? 'Finishing…'
          : listening || (elsewhere && busy)
            ? 'Stop'
            : starting
              ? 'Warming up…'
              : continues
                ? 'Record more'
                : 'Record'}
      </Button>
      {starting ? (
        <Button size="sm" variant="ghost" className="no-drag" onClick={onToggle}>
          Cancel
        </Button>
      ) : null}
      {listening ? readout : null}
      {busy ? null : (
        <ToggleGroup
          type="single"
          role="radiogroup"
          aria-label="Record from"
          className="no-drag"
          value={systemAudio ? 'both' : 'mic'}
          onValueChange={(next) => {
            if (next === 'mic' || next === 'both') onSystemAudioChange(next === 'both')
          }}
        >
          <ToggleGroupItem value="mic" role="radio" aria-checked={!systemAudio} aria-label="Mic only" {...tip('Mic only')}>
            <MicIcon />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="both"
            role="radio"
            aria-checked={systemAudio}
            aria-label="Mic and computer audio"
            {...tip('Mic and computer audio · for calls')}
          >
            <SpeakerIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    </span>
  )
}

const BARS = 14
/** A new bar joins the meter this often; the audio arrives far faster, and showing every frame flickers. */
const STEP_MS = 90

/**
 * A source's level as a short, slowly scrolling waveform: the loudest moment of each step, held
 * and let down gently, in quiet ink (amber when it clips). Decorative to assistive tech; silence
 * warnings are said in words elsewhere.
 */
export function LevelMeter({ subscribe, track }: { subscribe: SubscribeLevel; track: keyof Levels }) {
  const bars = useRef<(HTMLElement | null)[]>([])
  useEffect(() => {
    const history = new Array<number>(BARS).fill(0)
    let peak = 0
    let held = 0
    let last = 0
    return subscribe((levels) => {
      peak = Math.max(peak, Math.min(1, (levels[track] ?? 0) * 1.6))
      const now = performance.now()
      if (now - last < STEP_MS) return
      last = now
      // Rise at once, fall gently: speech reads as shapes, not a strobe.
      held = Math.max(peak, held * 0.6)
      peak = 0
      history.shift()
      history.push(held)
      history.forEach((value, index) => {
        const bar = bars.current[index]
        if (!bar) return
        bar.style.transform = `scaleY(${String(0.12 + value * 0.88)})`
        bar.dataset.hot = value > 0.95 ? 'true' : 'false'
      })
    })
  }, [subscribe, track])
  return (
    <span className="inline-flex h-3.5 items-center gap-px" aria-hidden="true">
      {Array.from({ length: BARS }, (_, index) => (
        <i
          key={index}
          ref={(node) => {
            bars.current[index] = node
          }}
          data-hot="false"
          style={{ transform: 'scaleY(0.12)' }}
          className="block h-full w-[2px] origin-center rounded-full bg-text-2 transition-transform duration-[90ms] ease-linear data-[hot=true]:bg-warning"
        />
      ))}
    </span>
  )
}

/** The recorder's error or notice, shown as a transient notice. */
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
  return <Toast text={notice} onDismiss={onDismiss} />
}

/**
 * While computer audio was asked for but isn't being recorded: trying again, given up (Retry),
 * or refused by macOS (Open Settings; it applies the change at launch). Stays until it's back,
 * the recording stops, or it's closed.
 */
export function SystemAudioMessage({
  state,
  onRetry,
  onDismiss
}: {
  state: SystemAudioState
  onRetry: () => void
  onDismiss: () => void
}) {
  switch (state) {
    case 'off':
    case 'live':
      return null
    case 'retrying':
      return (
        <Toast role="status" icon="spinner" text="Computer audio isn’t being recorded. Trying again…" onDismiss={onDismiss} />
      )
    case 'unavailable':
      return (
        <Toast
          role="alert"
          text="Couldn’t capture computer audio, so this is your microphone only."
          onDismiss={onDismiss}
          action={
            <button type="button" className="toast-action" onClick={onRetry}>
              Retry
            </button>
          }
        />
      )
    case 'blocked':
      return (
        <Toast
          role="alert"
          text="macOS isn’t letting Lyra record computer audio, so this is your microphone only. Allow it, then restart Lyra."
          onDismiss={onDismiss}
          action={
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
          }
        />
      )
  }
}

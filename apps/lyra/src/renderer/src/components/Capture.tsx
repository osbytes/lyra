import { useState, type ReactNode } from 'react'
import type { SystemAudioState } from '../audio/recovery'
import type { DictationPhase } from '../hooks/useDictation'
import { shortcutLabel } from '../lib/format'
import { cn } from '../lib/utils'
import { phaseAnnouncement } from '../lib/status'
import { notify } from '../lib/toast'
import { MicIcon, RecordIcon, StopIcon } from './Icons'
import { MicSystemIcon, useLevelHalo, type SubscribeLevel } from './Recording'
import { Toast } from './ToastStack'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { Spinner } from './ui/status'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

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
  /** The recorder's levels, so Stop breathes with the voice while this session records. */
  subscribeLevel?: SubscribeLevel
}

/**
 * The record control, in the session header: one button whose label and icon change and whose
 * position never moves. Idle: a hollow ring, "Record" (or "Record more"). Starting: a dashed
 * ring, cancellable. Listening: a soft red capsule the same height, holding a red "Stop" that
 * breathes with the voice, then the time and a meter per source (the readout) — the same object
 * as the floating pill. Finishing: a spinner. Beside it while idle the source, mic or mic and
 * computer audio.
 */
export function RecordControl({
  phase,
  continues,
  systemAudio,
  onSystemAudioChange,
  onToggle,
  elsewhere,
  size = 'lg',
  readout,
  subscribeLevel
}: RecordProps) {
  const announcement = usePhaseAnnouncement(phase)
  const listening = phase === 'listening' && !elsewhere
  const starting = phase === 'starting' && !elsewhere
  const finishing = phase === 'finishing' && !elsewhere
  const busy = phase !== 'idle'
  const live = listening && !!readout
  const halo = useLevelHalo<HTMLButtonElement>(subscribeLevel, live)
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
      {/* Always this wrapper, so Stop is the same element as Record and keeps keyboard focus. */}
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full',
          live && 'gap-2.5 bg-record-soft pr-3.5',
          live && (size === 'lg' ? 'h-10 pl-1' : 'h-[26px] pl-0.5')
        )}
      >
        <Button
          ref={halo}
          size={live ? (size === 'lg' ? 'md' : 'sm') : size}
          variant={listening || (elsewhere && phase === 'listening') ? 'record' : 'secondary'}
          className={cn(
            'no-drag',
            live && 'level-halo rounded-full transition-[background-color,border-color,color,box-shadow]',
            live && size !== 'lg' && 'h-[22px]'
          )}
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
        {live ? readout : null}
      </span>
      {starting ? (
        <Button size="sm" variant="ghost" className="no-drag" onClick={onToggle}>
          Cancel
        </Button>
      ) : null}
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
            <MicSystemIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      )}
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

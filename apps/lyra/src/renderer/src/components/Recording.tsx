import { useEffect, useRef, useState } from 'react'
import type { Levels } from '../hooks/useDictation'
import { clockLabel } from '../lib/format'
import { shortDeviceName } from '../lib/deviceName'
import { cn } from '../lib/utils'
import { MicIcon } from './Icons'
import { tip } from './Tooltip'

/*
 * What a recording looks like while it runs, shared by the header's capsule and the floating
 * pill (a separate, light window: keep this module free of the app's heavier imports).
 */

const BARS = 16
/** A new bar joins the meter this often; the audio arrives far faster, and showing every frame flickers. */
const STEP_MS = 90

export type SubscribeLevel = (listener: (levels: Levels) => void) => () => void

/** Seconds since `since`, ticking once a second while it's set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? 0 : Math.max(0, (now - since) / 1000)
}

/**
 * Sets `--level` (0–1, the louder source) on the returned element while `active`, for the
 * `.level-halo` ring: the one live signal on Stop, in place of a separate pulsing dot.
 */
export function useLevelHalo<T extends HTMLElement>(subscribe: SubscribeLevel | undefined, active: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const node = ref.current
    if (!subscribe || !active || !node) return
    let last = 0
    const stop = subscribe((levels) => {
      const now = performance.now()
      if (now - last < STEP_MS) return
      last = now
      node.style.setProperty('--level', String(Math.min(1, Math.max(levels.mic, levels.system ?? 0) * 1.6)))
    })
    return () => {
      stop()
      node.style.removeProperty('--level')
    }
  }, [subscribe, active])
  return ref
}

/**
 * The mic with sound leaving it on the right, in the computer-audio colour: "and what plays".
 * Used for the source choice too, so the meter's colour is learned before recording.
 */
export function MicSystemIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <g transform="translate(-2 0)">
        <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
        <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
      </g>
      <path d="M12.25 4.25a4 4 0 0 1 0 5.5M14.5 2.5a6.5 6.5 0 0 1 0 9" stroke="var(--source-system)" />
    </svg>
  )
}

/**
 * Both sources in one short, slowly scrolling waveform: the loudest moment of each step, held
 * and let down gently. The mic is quiet ink; computer audio is drawn over it, translucent, in
 * its own colour, so in a call you see who's talking and crosstalk shows as both. No clipping
 * colour: the levels are loudness (RMS), which tops out on ordinary speech, so it cried wolf.
 * Decorative to assistive tech; silence warnings are said in words elsewhere.
 */
export function SourcesMeter({ subscribe }: { subscribe: SubscribeLevel }) {
  const mics = useRef<(HTMLElement | null)[]>([])
  const systems = useRef<(HTMLElement | null)[]>([])
  useEffect(() => {
    const tracks = ['mic', 'system'] as const
    const history = { mic: new Array<number>(BARS).fill(0), system: new Array<number>(BARS).fill(0) }
    const peak = { mic: 0, system: 0 }
    const held = { mic: 0, system: 0 }
    let last = 0
    return subscribe((levels) => {
      for (const track of tracks) peak[track] = Math.max(peak[track], Math.min(1, (levels[track] ?? 0) * 1.6))
      const now = performance.now()
      if (now - last < STEP_MS) return
      last = now
      for (const track of tracks) {
        // Rise at once, fall gently: speech reads as shapes, not a strobe.
        held[track] = Math.max(peak[track], held[track] * 0.6)
        peak[track] = 0
        history[track].shift()
        history[track].push(held[track])
      }
      for (const [bars, values, floor] of [
        [mics.current, history.mic, 0.12],
        // Silent computer audio draws nothing, so a quiet call leaves the mic's ink alone.
        [systems.current, history.system, 0]
      ] as const) {
        values.forEach((value, index) => {
          const bar = bars[index]
          if (bar) bar.style.transform = `scaleY(${String(floor + value * (1 - floor))})`
        })
      }
    })
  }, [subscribe])
  const bar = 'absolute inset-0 block origin-center rounded-full transition-transform duration-[90ms] ease-linear'
  return (
    <span className="inline-flex h-4 items-stretch gap-px" aria-hidden="true">
      {Array.from({ length: BARS }, (_, index) => (
        <span key={index} className="relative block w-[2px]">
          <i
            ref={(node) => {
              mics.current[index] = node
            }}
            style={{ transform: 'scaleY(0.12)' }}
            className={cn(bar, 'bg-text-2')}
          />
          <i
            ref={(node) => {
              systems.current[index] = node
            }}
            style={{ transform: 'scaleY(0)', background: 'var(--source-system)' }}
            className={cn(bar, 'opacity-75')}
          />
        </span>
      ))}
    </span>
  )
}

type ReadoutProps = {
  startedAt: number | null
  micName: string | null
  systemAudio: boolean
  /** The recorder's levels, for the meter. */
  subscribeLevel: SubscribeLevel
  className?: string
}

/**
 * While a session records: the time and one meter for both sources. Beside Stop in the header
 * (where the source choice sits while idle, so recording never adds a row) and in the floating
 * pill, so both read the same. Stop's level halo is the live signal, so there's no extra dot.
 */
export function RecordingReadout({ startedAt, micName, systemAudio, subscribeLevel, className }: ReadoutProps) {
  const elapsed = useElapsed(startedAt)
  const micLabel = micName ? shortDeviceName(micName) : 'Microphone'
  return (
    <span
      className={cn('no-drag inline-flex items-center gap-2.5 text-[12.5px] text-text-2', className)}
      role="status"
      aria-label="Recording"
    >
      {/* Wide enough for 59:59 so the meters don't step right at the ten-minute mark. */}
      <span className="min-w-[5ch] font-mono text-[14px] font-medium tabular-nums text-foreground" role="timer">
        {clockLabel(elapsed)}
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        {...tip(systemAudio ? `${micLabel} and computer audio (in colour)` : micLabel)}
      >
        {systemAudio ? <MicSystemIcon /> : <MicIcon className="shrink-0" />}
        <SourcesMeter subscribe={subscribeLevel} />
      </span>
    </span>
  )
}

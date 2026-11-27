import { clockLabel } from '../lib/format'
import { pausePlayback, play, resumePlayback, stopPlayback, usePlayback } from '../lib/playback'
import { CloseIcon, PauseIcon, PlayIcon } from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'

type Timed = { id: string; start: number; end: number }

/**
 * While a session plays through: pause or resume, where it is of how long, a bar to seek on,
 * and stop. Floats at the foot of the transcript; gone once playback stops.
 */
export function PlayerBar({ pageId, lines }: { pageId: string; lines: readonly Timed[] }) {
  const state = usePlayback()
  if (state?.pageId !== pageId || state.key === 'picker') return null
  const end = state.end
  const share = end > 0 ? Math.min(1, state.position / end) : 0
  return (
    <div
      className="player-bar absolute bottom-4 left-1/2 z-[3] flex w-[min(420px,calc(100%-32px))] -translate-x-1/2 items-center gap-2.5 rounded-full border-(length:--border-width) border-border bg-popover py-1 pr-2 pl-1 shadow-md"
      role="group"
      aria-label="Playback"
    >
      <Button
        size="icon-sm"
        variant="primary"
        className="rounded-full"
        aria-label={state.paused ? 'Resume' : 'Pause'}
        {...tip(state.paused ? 'Resume' : 'Pause')}
        onClick={() => (state.paused ? resumePlayback() : pausePlayback())}
      >
        {state.paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      <span className="font-mono text-label tabular-nums" role="timer">
        {clockLabel(state.position)}
      </span>
      <button
        type="button"
        className="relative h-1.5 min-w-0 flex-1 cursor-pointer rounded-full bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(end)}
        aria-valuenow={Math.round(state.position)}
        aria-valuetext={`${clockLabel(state.position)} of ${clockLabel(end)}`}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          void play({ pageId, from: ((event.clientX - box.left) / Math.max(1, box.width)) * end, end, lines })
        }}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0
          if (!step) return
          event.preventDefault()
          void play({ pageId, from: state.position + step, end, lines })
        }}
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${String(share * 100)}%` }} />
      </button>
      <span className="font-mono text-label tabular-nums text-text-3">{clockLabel(end)}</span>
      <Button size="icon-sm" variant="ghost" aria-label="Stop playback" {...tip('Stop')} onClick={stopPlayback}>
        <CloseIcon />
      </Button>
    </div>
  )
}

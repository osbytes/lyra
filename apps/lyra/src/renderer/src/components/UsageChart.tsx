import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { UsageSample } from '../../../shared/types'

const WIDTH = 600
const HEIGHT = 120
/** The graphs always span this window, so a fresh launch shows a short line at the right. */
export const WINDOW_MS = 30 * 60 * 1000

type Props = {
  title: string
  samples: UsageSample[]
  intervalMs: number
  value: (sample: UsageSample) => number
  format: (value: number) => string
  /** The smallest top of the scale, so idle noise doesn't fill the chart. */
  floor: number
  /** The scale tops out at a round number of these (1 for percent, a gigabyte for memory). */
  unit?: number
}

/** 1, 2 or 5 times a power of ten: the next round number at or above `value`. */
function niceMax(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((multiple) => multiple * power >= value) ?? 10
  return step * power
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Runs of samples with no gap longer than a few intervals: the sampler stops while the computer
 * sleeps, and a line drawn across that would claim readings that were never taken.
 */
function runs(samples: UsageSample[], intervalMs: number): UsageSample[][] {
  const out: UsageSample[][] = []
  let previous: UsageSample | undefined
  for (const sample of samples) {
    const current = out.at(-1)
    if (!current || !previous || sample.at - previous.at > intervalMs * 3) out.push([sample])
    else current.push(sample)
    previous = sample
  }
  return out
}

/** One series over the last 30 minutes: a 2px line over a light fill, with a hover readout. */
export function UsageChart({ title, samples, intervalMs, value, format, floor, unit = 1 }: Props) {
  const [active, setActive] = useState<number | null>(null)
  const end = samples.at(-1)?.at ?? Date.now()
  const start = end - WINDOW_MS
  const peak = samples.reduce<UsageSample | null>(
    (best, sample) => (!best || value(sample) > value(best) ? sample : best),
    null
  )
  const top = niceMax(Math.max(floor, peak ? value(peak) : 0) / unit) * unit
  const x = (at: number): number => ((at - start) / WINDOW_MS) * WIDTH
  const y = (sample: UsageSample): number => HEIGHT - (value(sample) / top) * HEIGHT

  const point = (at: number, top: number): string => `${x(at).toFixed(1)},${top.toFixed(1)}`
  const paths = runs(samples, intervalMs).map((run) => {
    const line = run
      .map((sample, index) => `${index ? 'L' : 'M'}${point(sample.at, y(sample))}`)
      .join('')
    const first = run[0]
    const last = run.at(-1)
    const area =
      first && last ? `${line}L${point(last.at, HEIGHT)}L${point(first.at, HEIGHT)}Z` : ''
    return { key: first?.at ?? 0, line, area }
  })

  const nearest = (clientX: number, rect: DOMRect): number | null => {
    if (!samples.length) return null
    const at = start + ((clientX - rect.left) / rect.width) * WINDOW_MS
    let best = 0
    samples.forEach((sample, index) => {
      const current = samples[best]
      if (current && Math.abs(sample.at - at) < Math.abs(current.at - at)) best = index
    })
    return best
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect()))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!samples.length) return
    const last = samples.length - 1
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    setActive((index) => Math.min(last, Math.max(0, (index ?? last) + step)))
    event.preventDefault()
  }

  const shown = active === null ? undefined : samples[active]
  const latest = samples.at(-1)
  const marked = shown ?? latest
  const label = `${title} over the last 30 minutes${peak ? `, peak ${format(value(peak))}` : ''}`
  /** Where a point sits in the plot box, in percent, for the HTML dot and tooltip. */
  const left = (at: number): string => `${String((x(at) / WIDTH) * 100)}%`

  return (
    <figure className="usage-chart">
      <figcaption>
        <span className="usage-chart-title">{title}</span>
        <span className="usage-chart-figures">
          {latest ? <span>now {format(value(latest))}</span> : null}
          {peak ? (
            <span>
              peak {format(value(peak))} at {clockTime(peak.at)}
            </span>
          ) : null}
        </span>
      </figcaption>
      <div
        className="usage-chart-plot"
        role="img"
        tabIndex={0}
        aria-label={label}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          setActive(null)
        }}
        onFocus={() => {
          setActive(samples.length ? samples.length - 1 : null)
        }}
        onBlur={() => {
          setActive(null)
        }}
        onKeyDown={onKeyDown}
      >
        <span className="usage-chart-top">{format(top)}</span>
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line className="usage-chart-grid" x1="0" x2={WIDTH} y1="0.5" y2="0.5" />
          <line className="usage-chart-grid" x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />
          <line className="usage-chart-axis" x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
          {paths.map((path) => (
            <g key={path.key}>
              <path className="usage-chart-area" d={path.area} />
              <path className="usage-chart-line" d={path.line} />
            </g>
          ))}
          {shown ? (
            <line
              className="usage-chart-crosshair"
              x1={x(shown.at)}
              x2={x(shown.at)}
              y1="0"
              y2={HEIGHT}
            />
          ) : null}
        </svg>
        {marked ? (
          // The latest reading is always marked: a single sample draws no line on its own.
          <span
            className="usage-chart-dot"
            style={{ left: left(marked.at), top: `${String((y(marked) / HEIGHT) * 100)}%` }}
          />
        ) : null}
        {shown ? (
          <>
            <span
              className={`usage-chart-tooltip${x(shown.at) > WIDTH * 0.7 ? ' is-left' : ''}`}
              style={{ left: left(shown.at) }}
            >
              <strong>{format(value(shown))}</strong>
              <small>{clockTime(shown.at)}</small>
            </span>
          </>
        ) : null}
      </div>
      <div className="usage-chart-axis-labels" aria-hidden="true">
        <span>30 min ago</span>
        <span>now</span>
      </div>
    </figure>
  )
}

'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { MicIcon, PeopleIcon, SpeakerIcon } from './SiteIcons'
import styles from './heroGraph.module.css'

// Everything is laid out in a 720×600 box. The DOM layer places avatars, labels and cards in
// percentages of it, and the canvas draws the constellation and the moving words in the same
// units. The sky behind it is the hero's.
const W = 720
const H = 600

type Point = { x: number; y: number }
type Input = 'you' | 'meeting' | 'call'
type Engine = 'lyra' | 'whisper' | 'llm'
type Node = Input | Engine

// The constellation Lyra, filling the picture. What Lyra hears sits on the parallelogram (β, γ,
// δ). Lyra itself is ζ, the star in the middle where the parallelogram meets the small triangle,
// and behind it on the triangle are the two models it runs on this computer: Whisper on Vega and
// the local LLM on ε. What each one makes hangs beside its star.
const STARS: Record<Node, Point> = {
  lyra: { x: 330, y: 340 }, // ζ
  whisper: { x: 376, y: 486 }, // Vega
  llm: { x: 474, y: 414 }, // ε
  you: { x: 268, y: 90 }, // β
  call: { x: 104, y: 40 }, // γ
  meeting: { x: 167, y: 282 } // δ
}

const LINES: readonly (readonly [Node, Node])[] = [
  ['lyra', 'whisper'],
  ['lyra', 'llm'],
  ['whisper', 'llm'],
  ['lyra', 'you'],
  ['you', 'call'],
  ['call', 'meeting'],
  ['meeting', 'lyra']
]

// The inputs wear the app's speaker avatars (its tones), drawn over their stars.
const INPUTS: readonly { id: Input; name: string; tone: string | null; mark: ReactNode }[] = [
  { id: 'you', name: 'You', tone: null, mark: <MicIcon /> },
  { id: 'meeting', name: 'Meeting', tone: '0', mark: <PeopleIcon /> },
  { id: 'call', name: 'Call audio', tone: '2', mark: <SpeakerIcon /> }
]

type Side = 'right' | 'belowLeft'

const ENGINES: readonly { id: Engine; name: string; note: string; side: Side }[] = [
  { id: 'lyra', name: 'Lyra', note: 'On this computer', side: 'belowLeft' },
  { id: 'whisper', name: 'Whisper', note: 'Transcription', side: 'right' },
  { id: 'llm', name: 'Local LLM', note: 'Notes', side: 'right' }
]

type CardId = 'speakers' | 'saved' | 'transcript' | 'summary' | 'actions'

/** Each card hangs beside the star that makes it: left edge (or right, for `toLeft`), middle. */
const CARDS: Record<CardId, { at: Point; w: number; from: Engine; toLeft?: boolean }> = {
  speakers: { at: { x: 392, y: 214 }, w: 230, from: 'lyra' },
  saved: { at: { x: 392, y: 290 }, w: 230, from: 'lyra' },
  transcript: { at: { x: 344, y: 470 }, w: 230, from: 'whisper', toLeft: true },
  summary: { at: { x: 500, y: 474 }, w: 212, from: 'llm' },
  actions: { at: { x: 500, y: 538 }, w: 212, from: 'llm' }
}

const CARD_IDS = Object.keys(CARDS).filter((id): id is CardId => id in CARDS)

/** Where a card's beam lands: the edge facing its star. */
const anchorOf = (id: CardId): Point => CARDS[id].at

/** Who a card's color comes from: a speaker, Lyra, or the local model. */
type Ink = Input | 'lyra' | 'llm'

type Beat = { card: CardId; ink: Ink; kind: string; text: string }

// A meeting as Lyra handles it: lines are transcribed as they're said, Lyra works out who said
// them, the local model writes the summary and action items, and it all lands in a plain file.
const SCRIPT: readonly Beat[] = [
  { card: 'transcript', ink: 'you', kind: 'Transcript · You', text: 'Let’s ship the dock first.' },
  { card: 'speakers', ink: 'lyra', kind: 'Speakers', text: 'You · Dana · Sam' },
  { card: 'transcript', ink: 'call', kind: 'Transcript · Alex', text: 'Does the pill need a hotkey?' },
  { card: 'summary', ink: 'llm', kind: 'Summary', text: 'The dock ships first.' },
  { card: 'speakers', ink: 'lyra', kind: 'Speakers', text: 'Alex · matched a saved voice' },
  { card: 'transcript', ink: 'meeting', kind: 'Transcript · Sam', text: 'I’ll check the contrast today.' },
  { card: 'actions', ink: 'llm', kind: 'Action item', text: 'Sam: check the contrast' },
  { card: 'saved', ink: 'lyra', kind: 'Saved', text: '~/.lyra/design-review.md' },
  { card: 'actions', ink: 'llm', kind: 'Action item', text: 'Alex: try a pill hotkey' },
  { card: 'saved', ink: 'lyra', kind: 'Uploaded', text: 'Nothing. It stays here.' }
]

/** How a beat's words travel: in from a voice through Lyra to Whisper, or out from Lyra. */
function routeOf(beat: Beat): readonly Node[] {
  if (beat.ink === 'you') return ['you', 'lyra', 'whisper']
  if (beat.ink === 'meeting') return ['meeting', 'lyra', 'whisper']
  if (beat.ink === 'call') return ['call', 'you', 'lyra', 'whisper']
  if (beat.ink === 'llm') return ['lyra', 'llm']
  return ['lyra']
}

/** Resolved colors for the canvas, which can't read CSS variables itself. */
type Palette = Record<Ink | 'whisper', string>

function readPalette(root: HTMLElement): Palette {
  const css = getComputedStyle(root)
  // An unset value reads as '', which the canvas would ignore; fall back to the dark accent.
  const accent = css.getPropertyValue('--accent').trim() || '#6158f0'
  const tone = (input: Input): string => {
    const avatar = root.querySelector(`[data-input="${input}"] .speaker-avatar`)
    return avatar ? getComputedStyle(avatar).color : accent
  }
  return {
    lyra: accent,
    whisper: 'rgb(220, 225, 255)',
    llm: css.getPropertyValue('--llm').trim() || accent,
    you: tone('you'),
    meeting: tone('meeting'),
    call: tone('call')
  }
}

const BEAT_MS = 2200
/** Pixels per millisecond a word travels. */
const SPEED = 0.55

/** A word's trip: its route's stars, then the card it lands on. */
type Flight = { points: Point[]; nodes: Node[]; at: number[]; total: number; ink: Ink; start: number; duration: number }
type Ripple = { at: Point; ink: Ink; start: number; size: number }

function flightFor(beat: Beat, start: number): Flight {
  const nodes = [...routeOf(beat)]
  const points = [...nodes.map((n) => STARS[n]), anchorOf(beat.card)]
  const at = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const prev = at[i - 1] ?? 0
    at.push(a && b ? prev + Math.hypot(b.x - a.x, b.y - a.y) : prev)
  }
  const total = at[at.length - 1] ?? 0
  return { points, nodes, at, total, ink: beat.ink, start, duration: Math.max(650, total / SPEED) }
}

/** The point a distance `d` along a flight's path. */
function pointAt(f: Flight, d: number): Point {
  for (let i = 1; i < f.points.length; i++) {
    const a = f.points[i - 1]
    const b = f.points[i]
    const lo = f.at[i - 1] ?? 0
    const hi = f.at[i] ?? 0
    if (a && b && d <= hi) {
      const t = hi > lo ? (d - lo) / (hi - lo) : 1
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  return f.points[f.points.length - 1] ?? STARS.lyra
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** The inverse of `ease`, to find when an eased trip reaches a given distance. */
const easeInverse = (y: number): number => (y < 0.5 ? Math.cbrt(y / 4) : (2 - Math.cbrt(2 * (1 - y))) / 2)

/** A soft glowing point, colored by any CSS color the browser resolved. */
function glow(ctx: CanvasRenderingContext2D, p: Point, r: number, blur: number, color: string, alpha: number): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.shadowColor = color
  ctx.shadowBlur = blur
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function spikes(ctx: CanvasRenderingContext2D, p: Point, length: number, alpha: number): void {
  ctx.globalAlpha = alpha
  ctx.strokeStyle = 'rgba(240, 240, 255, 1)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(p.x - length, p.y)
  ctx.lineTo(p.x + length, p.y)
  ctx.moveTo(p.x, p.y - length)
  ctx.lineTo(p.x, p.y + length)
  ctx.stroke()
}

function draw(ctx: CanvasRenderingContext2D, now: number, flights: Flight[], ripples: Ripple[], c: Palette): void {
  ctx.clearRect(0, 0, W, H)

  // The constellation's lines, and a faint tether from each card to its star.
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(200, 205, 255, 0.28)'
  ctx.lineWidth = 1
  for (const [a, b] of LINES) {
    ctx.beginPath()
    ctx.moveTo(STARS[a].x, STARS[a].y)
    ctx.lineTo(STARS[b].x, STARS[b].y)
    ctx.stroke()
  }
  ctx.setLineDash([2, 5])
  ctx.strokeStyle = 'rgba(200, 205, 255, 0.2)'
  for (const id of CARD_IDS) {
    const from = STARS[CARDS[id].from]
    const to = anchorOf(id)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // A word lights the lines it travels.
  for (const f of flights) {
    const t = (now - f.start) / f.duration
    if (t < 0 || t > 1.4) continue
    ctx.globalAlpha = 0.55 * Math.sin((Math.PI * Math.min(t, 1.4)) / 1.4)
    ctx.strokeStyle = c[f.ink]
    ctx.lineWidth = 1.4
    ctx.beginPath()
    f.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
  }

  // The inputs' stars glow behind their avatars; Whisper and the model are bright stars of their own.
  for (const input of INPUTS) glow(ctx, STARS[input.id], 14, 34, c[input.id], 0.55)
  const twinkle = 0.85 + 0.15 * Math.sin(now / 900)
  glow(ctx, STARS.whisper, 8, 24, c.whisper, 0.55 * twinkle)
  glow(ctx, STARS.whisper, 3.4, 8, '#ffffff', 1)
  spikes(ctx, STARS.whisper, 16 * twinkle, 0.45)
  glow(ctx, STARS.llm, 8, 24, c.llm, 0.55 * twinkle)
  glow(ctx, STARS.llm, 3, 8, '#fffbe8', 1)
  spikes(ctx, STARS.llm, 14 * twinkle, 0.4)

  // Lyra: the brightest, a white core in an accent halo, with a slow shimmer on its spikes.
  const lyra = STARS.lyra
  const shimmer = 0.85 + 0.15 * Math.sin(now / 700)
  glow(ctx, lyra, 28, 74, c.lyra, 0.6 * shimmer)
  glow(ctx, lyra, 9, 26, 'rgba(235, 235, 255, 1)', 0.9)
  spikes(ctx, lyra, 36 * shimmer, 0.6 * shimmer)
  glow(ctx, lyra, 4.4, 6, '#ffffff', 1)

  for (const r of ripples) {
    const t = (now - r.start) / 800
    if (t < 0 || t > 1) continue
    ctx.strokeStyle = c[r.ink]
    ctx.globalAlpha = 1 - t
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(r.at.x, r.at.y, 4 + r.size * ease(t), 0, Math.PI * 2)
    ctx.stroke()
  }

  for (const f of flights) {
    const t = (now - f.start) / f.duration
    if (t < 0 || t > 1) continue
    const color = c[f.ink]
    // A short comet tail of fading dots behind the head.
    for (let k = 10; k >= 0; k--) {
      const p = pointAt(f, ease(Math.max(0, t - k * 0.018)) * f.total)
      if (k === 0) glow(ctx, p, 3.4, 14, color, 1)
      else glow(ctx, p, 2.2 * (1 - k / 14), 0, color, 0.5 * (1 - k / 11))
    }
  }
  ctx.globalAlpha = 1
}

const pct = (value: number, of: number): string => `${String((value / of) * 100)}%`

/** Inline position plus the `--c` color the stylesheet tints with. */
type Placed = CSSProperties & { '--c': string }

const place = (x: number, y: number, color: string): Placed => ({ left: pct(x, W), top: pct(y, H), '--c': color })

/** Before anything plays, each card shows its last line in the script, so the loop reads on. */
function firstCards(): Record<CardId, { beat: Beat; n: number }> {
  const last = (id: CardId): Beat =>
    [...SCRIPT].reverse().find((b) => b.card === id) ?? { card: id, ink: 'lyra', kind: '', text: '' }
  return {
    speakers: { beat: last('speakers'), n: 0 },
    saved: { beat: last('saved'), n: 0 },
    transcript: { beat: last('transcript'), n: 0 },
    summary: { beat: last('summary'), n: 0 },
    actions: { beat: last('actions'), n: 0 }
  }
}

/**
 * The hero's picture: the constellation Lyra. What you say, a meeting and a call's audio flow into
 * Lyra in the middle; Whisper behind it writes the transcript, Lyra labels who spoke and saves the
 * file, and the local model writes the summary and action items. Decorative; the copy beside it
 * says the same.
 */
export function HeroGraph() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The colors as the browser resolved them, for the cards' dots; null until mounted.
  const [palette, setPalette] = useState<Palette | null>(null)
  const [cards, setCards] = useState(firstCards)
  const [lit, setLit] = useState<Node | null>(null)
  const [fresh, setFresh] = useState<CardId | null>(null)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!root || !canvas || !ctx) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const flights: Flight[] = []
    const ripples: Ripple[] = []
    const timers = new Set<number>()
    const later = (ms: number, fn: () => void): void => {
      const id = window.setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }
    let frame = 0
    let visible = false
    let beat = 0
    const colors = readPalette(root)
    setPalette(colors)

    const fit = (): void => {
      const scale = (canvas.clientWidth / W) * window.devicePixelRatio
      canvas.width = Math.round(W * scale)
      canvas.height = Math.round(H * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      draw(ctx, performance.now(), flights, ripples, colors)
    }

    const tick = (now: number): void => {
      draw(ctx, now, flights, ripples, colors)
      frame = visible ? requestAnimationFrame(tick) : 0
    }

    const flare = (node: Node, ink: Ink): void => {
      ripples.push({ at: STARS[node], ink, start: performance.now(), size: node === 'lyra' ? 32 : 20 })
      if (ripples.length > 8) ripples.splice(0, ripples.length - 8)
      setLit(node)
      later(700, () => {
        setLit((current) => (current === node ? null : current))
      })
    }

    const play = (): void => {
      if (!visible || document.hidden) return
      const next = SCRIPT[beat % SCRIPT.length]
      beat += 1
      later(BEAT_MS, play)
      if (!next) return
      const flight = flightFor(next, performance.now())
      flights.push(flight)
      if (flights.length > 4) flights.shift()
      // Each star the word passes flares as it does.
      flight.nodes.forEach((node, i) => {
        const when = flight.duration * easeInverse((flight.at[i] ?? 0) / Math.max(1, flight.total))
        later(when, () => flare(node, flight.ink))
      })
      later(flight.duration, () => {
        ripples.push({ at: anchorOf(next.card), ink: flight.ink, start: performance.now(), size: 14 })
        setCards((all) => ({ ...all, [next.card]: { beat: next, n: all[next.card].n + 1 } }))
        setFresh(next.card)
        later(1400, () => {
          setFresh((current) => (current === next.card ? null : current))
        })
      })
    }

    const resize = new ResizeObserver(fit)
    resize.observe(canvas)
    if (still) return () => resize.disconnect()

    const seen = new IntersectionObserver(([entry]) => {
      const was = visible
      visible = entry?.isIntersecting ?? false
      if (visible && !was) {
        frame = requestAnimationFrame(tick)
        later(600, play)
      }
      if (!visible) {
        for (const id of timers) window.clearTimeout(id)
        timers.clear()
      }
    })
    seen.observe(canvas)

    return () => {
      resize.disconnect()
      seen.disconnect()
      cancelAnimationFrame(frame)
      for (const id of timers) window.clearTimeout(id)
    }
  }, [])

  const colorOf = (key: keyof Palette): string => palette?.[key] ?? 'var(--accent)'

  return (
    <div ref={rootRef} className={cx('lyra-ui', styles.graph)} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
      {INPUTS.map((input) => (
        <div
          key={input.id}
          data-input={input.id}
          className={cx(styles.voice, lit === input.id && styles.speaking)}
          style={place(STARS[input.id].x, STARS[input.id].y, colorOf(input.id))}
        >
          <span className={cx('speaker-avatar', styles.dot)} data-tone={input.tone ?? undefined}>
            {input.mark}
          </span>
          <span className={styles.voiceName}>{input.name}</span>
        </div>
      ))}
      {ENGINES.map((engine) => (
        <div
          key={engine.id}
          className={cx(styles.engine, styles[engine.side], engine.id === 'lyra' && styles.main, lit === engine.id && styles.lit)}
          style={place(STARS[engine.id].x, STARS[engine.id].y, colorOf(engine.id))}
        >
          <span className={styles.engineName}>{engine.name}</span>
          <span className={styles.engineNote}>{engine.note}</span>
        </div>
      ))}
      {CARD_IDS.map((id) => {
        const { at, w, toLeft } = CARDS[id]
        const entry = cards[id]
        return (
          <div
            key={`${id}-${String(entry.n)}`}
            className={cx(styles.card, toLeft && styles.toLeft, entry.n > 0 && styles.enter, fresh === id && styles.fresh)}
            style={{ ...place(at.x, at.y, colorOf(entry.beat.ink)), width: pct(w, W) }}
          >
            <span className={styles.kind}>{entry.beat.kind}</span>
            <span className={styles.text}>{entry.beat.text}</span>
          </div>
        )
      })}
    </div>
  )
}

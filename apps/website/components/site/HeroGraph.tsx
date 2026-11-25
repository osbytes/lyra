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
type Input = 'mic' | 'meeting' | 'system'
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
  mic: { x: 268, y: 90 }, // β
  meeting: { x: 104, y: 40 }, // γ
  system: { x: 167, y: 282 } // δ
}

const LINES: readonly (readonly [Node, Node])[] = [
  ['lyra', 'whisper'],
  ['lyra', 'llm'],
  ['whisper', 'llm'],
  ['lyra', 'mic'],
  ['mic', 'meeting'],
  ['meeting', 'system'],
  ['system', 'lyra']
]

// The inputs wear the app's speaker avatars (its tones), drawn over their stars.
const INPUTS: readonly { id: Input; name: string; tone: string | null; mark: ReactNode }[] = [
  { id: 'mic', name: 'Mic', tone: null, mark: <MicIcon /> },
  { id: 'meeting', name: 'Meeting', tone: '0', mark: <PeopleIcon /> },
  { id: 'system', name: 'System audio', tone: '2', mark: <SpeakerIcon /> }
]

type Side = 'right' | 'belowLeft'

const ENGINES: readonly { id: Engine; name: string; note: string; side: Side }[] = [
  { id: 'lyra', name: 'Lyra', note: 'On this computer', side: 'belowLeft' },
  { id: 'whisper', name: 'Whisper', note: 'Speakers · Text', side: 'right' },
  { id: 'llm', name: 'LLM', note: 'Notes', side: 'right' }
]

type CardId = 'whisper' | 'transcript' | 'summary' | 'actions'

/**
 * Each card hangs beside the star that makes it: its left edge (right, for `toLeft`) at `at`,
 * centred on it, or hanging down from it for `top` cards, which grow as lines arrive.
 */
const CARDS: Record<CardId, { at: Point; w: number; from: Engine; toLeft?: boolean; top?: boolean }> = {
  whisper: { at: { x: 344, y: 470 }, w: 230, from: 'whisper', toLeft: true },
  transcript: { at: { x: 392, y: 178 }, w: 272, from: 'lyra', top: true },
  summary: { at: { x: 500, y: 470 }, w: 212, from: 'llm' },
  actions: { at: { x: 500, y: 512 }, w: 212, from: 'llm', top: true }
}

const CARD_IDS = Object.keys(CARDS).filter((id): id is CardId => id in CARDS)

/** Where a card's beam lands: the edge facing its star, near the top of a growing card. */
function anchorOf(id: CardId): Point {
  const { at, top } = CARDS[id]
  return top ? { x: at.x, y: at.y + 22 } : at
}

/** Who a word's color comes from: an input, Lyra, Whisper, or the local model. */
type Ink = Input | Engine

type Line = { who: string; tone: string; where: string; text: string }

// The example meeting: Dana in the room on the mic, Sam and Alex on the call. Each line is heard on
// both tracks, Whisper works out who said it and writes it down, and once the meeting ends the
// local model turns the transcript into a summary and action items.
const MEETING: readonly Line[] = [
  { who: 'Dana', tone: '0', where: 'in the room', text: 'Let’s ship the dock first.' },
  { who: 'Sam', tone: '1', where: 'on the call', text: 'Agreed. I’ll check the contrast today.' },
  { who: 'Alex', tone: '2', where: 'on the call', text: 'Does the pill need a hotkey?' },
  { who: 'Dana', tone: '0', where: 'in the room', text: 'Yes. Try one before Friday.' }
]

const SUMMARY = 'The dock ships first, and the pill gets a hotkey.'

const ACTIONS: readonly string[] = ['Sam: check the dock’s contrast', 'Alex: try a pill hotkey by Friday']

/** What the cards show at a moment in the loop. */
type View = {
  /** Whisper's current step, and a key so each new step animates in. */
  step: { kind: string; text: string; n: number }
  /** How many meeting lines the transcript card shows. */
  lines: number
  summary: 'off' | 'busy' | 'done'
  /** How many action items are written. */
  actions: number
}

/** The finished meeting: what a still or not-yet-playing picture shows. */
const DONE: View = {
  step: { kind: 'Transcribed', text: '4 lines · 3 speakers', n: 0 },
  lines: MEETING.length,
  summary: 'done',
  actions: ACTIONS.length
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
    mic: tone('mic'),
    meeting: tone('meeting'),
    system: tone('system')
  }
}

/** Pixels per millisecond a word travels. */
const SPEED = 0.55

/** A word's trip: its route's stars, then the card it lands on, if any. */
type Flight = { points: Point[]; nodes: Node[]; at: number[]; total: number; ink: Ink; start: number; duration: number }
type Ripple = { at: Point; ink: Ink; start: number; size: number }

function flightFor(route: readonly Node[], ink: Ink, start: number, card?: CardId): Flight {
  const nodes = [...route]
  const points = nodes.map((n) => STARS[n])
  if (card) points.push(anchorOf(card))
  const at = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const prev = at[i - 1] ?? 0
    at.push(a && b ? prev + Math.hypot(b.x - a.x, b.y - a.y) : prev)
  }
  const total = at[at.length - 1] ?? 0
  return { points, nodes, at, total, ink, start, duration: Math.max(650, total / SPEED) }
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

/** How long the finished meeting stays up before the next one starts. */
const HOLD_MS = 5000
/** How long Whisper spends on each step: telling who spoke, then writing it down. */
const DIARIZE_MS = 900
const TRANSCRIBE_MS = 800

/**
 * The hero's picture: the constellation Lyra, playing one meeting on a loop. Each line leaves the
 * meeting on both the mic and the system audio, meets in Lyra, and goes to Whisper, which tells who
 * spoke and writes it down; the line comes back to Lyra's transcript. When the meeting ends, the
 * local model writes the summary and action items. Decorative; the copy beside it says the same.
 */
export function HeroGraph() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The colors as the browser resolved them, for the cards' dots; null until mounted.
  const [palette, setPalette] = useState<Palette | null>(null)
  const [view, setView] = useState<View>(DONE)
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
    let step = 0
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

    /** Sends a word along a route, flaring each star it passes; returns when it arrives. */
    const send = (route: readonly Node[], ink: Ink, card?: CardId): number => {
      const flight = flightFor(route, ink, performance.now(), card)
      flights.push(flight)
      if (flights.length > 6) flights.splice(0, flights.length - 6)
      flight.nodes.forEach((node, i) => {
        const when = flight.duration * easeInverse((flight.at[i] ?? 0) / Math.max(1, flight.total))
        later(when, () => flare(node, ink))
      })
      if (card) {
        later(flight.duration, () => {
          ripples.push({ at: anchorOf(card), ink, start: performance.now(), size: 14 })
        })
      }
      return flight.duration
    }

    const highlight = (card: CardId): void => {
      setFresh(card)
      later(1400, () => {
        setFresh((current) => (current === card ? null : current))
      })
    }

    const showStep = (kind: string, text: string): void => {
      step += 1
      const n = step
      setView((v) => ({ ...v, step: { kind, text, n } }))
      highlight('whisper')
    }

    // After the meeting: Lyra hands the transcript to the local model, which writes the summary
    // and then the action items, one at a time.
    const writeNotes = (): void => {
      const toModel = send(['lyra', 'llm'], 'llm')
      later(toModel, () => {
        setView((v) => ({ ...v, summary: 'busy' }))
        highlight('summary')
        later(1300, () => {
          setView((v) => ({ ...v, summary: 'done' }))
          highlight('summary')
          ACTIONS.forEach((_, i) => {
            later(i * 1100, () => {
              const landed = send(['llm'], 'llm', 'actions')
              later(landed, () => {
                setView((v) => ({ ...v, actions: i + 1 }))
                highlight('actions')
              })
            })
          })
          later(ACTIONS.length * 1100 + HOLD_MS, play)
        })
      })
    }

    // One line of the meeting: heard on both tracks, into Lyra, to Whisper and back.
    const hear = (i: number): void => {
      if (!visible || document.hidden) return
      const line = MEETING[i]
      if (!line) {
        later(900, writeNotes)
        return
      }
      const toWhisper = send(['meeting', 'mic', 'lyra', 'whisper'], 'meeting')
      send(['meeting', 'system', 'lyra'], 'meeting')
      later(toWhisper, () => {
        showStep('Diarizing', `${line.who} · ${line.where}`)
        later(DIARIZE_MS, () => {
          showStep('Transcribing', line.text)
          later(TRANSCRIBE_MS, () => {
            const back = send(['whisper', 'lyra'], 'whisper', 'transcript')
            later(back, () => {
              setView((v) => ({ ...v, lines: i + 1 }))
              highlight('transcript')
            })
            later(back + 500, () => hear(i + 1))
          })
        })
      })
    }

    const play = (): void => {
      if (!visible || document.hidden) return
      setView((v) => ({ ...v, lines: 0, summary: 'off', actions: 0 }))
      showStep('Listening', 'Mic and system audio')
      later(700, () => hear(0))
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
      <Card id="whisper" ink={colorOf('whisper')} fresh={fresh} hidden={false}>
        <span key={view.step.n} className={cx(styles.step, view.step.n > 0 && styles.enter)}>
          <span className={styles.kind}>{view.step.kind}</span>
          <span className={styles.text}>{view.step.text}</span>
        </span>
      </Card>
      <Card id="transcript" ink={colorOf('lyra')} fresh={fresh} hidden={false}>
        <span className={styles.kind}>Transcript</span>
        {view.lines === 0 ? <span className={styles.waiting}>Waiting for someone to speak…</span> : null}
        {MEETING.slice(0, view.lines).map((line, i) => (
          <span key={i} className={cx(styles.row, styles.enter)}>
            <span className={styles.who} data-tone={line.tone}>
              {line.who}
            </span>
            <span className={styles.said}>{line.text}</span>
          </span>
        ))}
      </Card>
      <Card id="summary" ink={colorOf('llm')} fresh={fresh} hidden={view.summary === 'off'}>
        <span className={styles.kind}>Summary</span>
        {view.summary === 'busy' ? (
          <span className={styles.waiting}>Writing from the transcript…</span>
        ) : (
          <span className={cx(styles.text, styles.wrap)}>{SUMMARY}</span>
        )}
      </Card>
      <Card id="actions" ink={colorOf('llm')} fresh={fresh} hidden={view.actions === 0}>
        <span className={styles.kind}>Action items</span>
        {ACTIONS.slice(0, view.actions).map((action) => (
          <span key={action} className={cx(styles.row, styles.enter)}>
            <span className={styles.box} aria-hidden="true" />
            <span className={styles.said}>{action}</span>
          </span>
        ))}
      </Card>
    </div>
  )
}

/** A card beside its star, tinted by `ink`; it fades out while it has nothing to show. */
function Card(props: { id: CardId; ink: string; fresh: CardId | null; hidden: boolean; children: ReactNode }) {
  const { at, w, toLeft, top } = CARDS[props.id]
  return (
    <div
      className={cx(
        styles.card,
        toLeft && styles.toLeft,
        top && styles.top,
        props.fresh === props.id && styles.fresh,
        props.hidden && styles.gone
      )}
      style={{ ...place(at.x, at.y, props.ink), width: pct(w, W) }}
    >
      {props.children}
    </div>
  )
}

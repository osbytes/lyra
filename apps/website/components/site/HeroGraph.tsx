'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { MicIcon, PersonIcon, SpeakerIcon } from './SiteIcons'
import styles from './heroGraph.module.css'

// Everything is laid out in a 560×600 box: the DOM layer places voices and cards in percentages
// of it, and the canvas draws the page, the links and the moving words in the same units.
const W = 560
const H = 600
const NODE_X = 52
const CARD_W = 220

type Voice = 'you' | 'dana' | 'sam' | 'call'

// Colors are the site's own tokens (globals.css), so the graph follows light and dark like the
// rest of the page. The speakers use the app's speaker colors.
type Token = '--accent' | '--accent-ink' | '--spk-2' | '--spk-3' | '--muted' | '--faint'

const VOICES: readonly { id: Voice; name: string; y: number; color: Token; icon: ReactNode }[] = [
  { id: 'you', name: 'You', y: 96, color: '--accent', icon: <MicIcon /> },
  { id: 'dana', name: 'Dana', y: 222, color: '--spk-2', icon: <PersonIcon /> },
  { id: 'sam', name: 'Sam', y: 348, color: '--spk-3', icon: <PersonIcon /> },
  { id: 'call', name: 'Call audio', y: 474, color: '--muted', icon: <SpeakerIcon /> }
]

/** What Lyra itself adds (summaries, tags, files) rather than a voice. */
const PAGE_COLOR: Token = '--accent-ink'

const colorOf = (voice: Voice | null): Token => VOICES.find((v) => v.id === voice)?.color ?? PAGE_COLOR

type Palette = Record<Token, string>

/** The tokens' current values, for the canvas, which can't read CSS variables itself. */
function readPalette(el: Element): Palette {
  const css = getComputedStyle(el)
  // An unset token reads as '', which the canvas would ignore; fall back to a neutral grey.
  const read = (token: Token): string => css.getPropertyValue(token).trim() || '#8b8b99'
  return {
    '--accent': read('--accent'),
    '--accent-ink': read('--accent-ink'),
    '--spk-2': read('--spk-2'),
    '--spk-3': read('--spk-3'),
    '--muted': read('--muted'),
    '--faint': read('--faint')
  }
}

/** The page: one long, gently bowed line that every word lands on. */
const spineX = (y: number): number => 284 + 14 * Math.sin(y / 160)

type Slot = { y: number; side: 'on' | 'right' }

const SLOTS: readonly Slot[] = [
  { y: 52, side: 'right' },
  { y: 134, side: 'on' },
  { y: 232, side: 'right' },
  { y: 322, side: 'on' },
  { y: 424, side: 'right' },
  { y: 524, side: 'on' }
]

const cardLeft = (slot: Slot): number => (slot.side === 'on' ? spineX(slot.y) - CARD_W / 2 : spineX(slot.y) + 38)

type Card = { kind: string; text: string; voice: Voice | null }

const FIRST: readonly Card[] = [
  { kind: 'Speaker', text: 'Dana · confirmed', voice: 'dana' },
  { kind: 'Transcript · Dana', text: 'Let’s ship the dock first.', voice: 'dana' },
  { kind: 'Action item', text: 'Sam: check dark-mode contrast', voice: null },
  { kind: 'Transcript · Sam', text: 'I’ll check it this afternoon.', voice: 'sam' },
  { kind: 'Call · Alex', text: 'Where did my recordings go?', voice: 'call' },
  { kind: 'Saved', text: 'design-review.md', voice: null }
]

type Beat = { slot: number; from: Voice | 'page'; card: Card }

const SCRIPT: readonly Beat[] = [
  { slot: 1, from: 'you', card: { kind: 'Dictation', text: 'Show the shortcut on hover.', voice: 'you' } },
  { slot: 0, from: 'page', card: { kind: 'Summary', text: 'The dock redesign ships first', voice: null } },
  { slot: 3, from: 'dana', card: { kind: 'Transcript · Dana', text: 'One primary action, one secondary.', voice: 'dana' } },
  { slot: 2, from: 'page', card: { kind: 'Tags', text: '#design  #team', voice: null } },
  { slot: 4, from: 'call', card: { kind: 'Call · Alex', text: 'Does the pill need a hotkey?', voice: 'call' } },
  { slot: 5, from: 'page', card: { kind: 'On this computer', text: 'Whisper · nothing uploaded', voice: null } },
  { slot: 3, from: 'sam', card: { kind: 'Transcript · Sam', text: 'I’ll check it this afternoon.', voice: 'sam' } },
  { slot: 0, from: 'page', card: { kind: 'Speaker', text: 'Sam · 71% match', voice: 'sam' } },
  { slot: 1, from: 'dana', card: { kind: 'Transcript · Dana', text: 'Let’s ship the dock first.', voice: 'dana' } },
  { slot: 2, from: 'page', card: { kind: 'Action item', text: 'Sam: check dark-mode contrast', voice: null } },
  { slot: 4, from: 'page', card: { kind: 'Correction', text: 'dock → dark mode', voice: null } },
  { slot: 5, from: 'page', card: { kind: 'Saved', text: 'design-review.md', voice: null } }
]

const BEAT_MS = 2000
const TRAVEL_MS = 950

type Point = { x: number; y: number }
type Flight = { from: Point; via: Point | null; to: Point; color: Token; start: number }
type Ripple = { at: Point; color: Token; start: number }

/** Where a beat's word starts and how it travels: a curve from a voice, or down the page. */
function flightFor(beat: Beat, start: number): Flight {
  const slot = SLOTS[beat.slot] ?? SLOTS[0] ?? { y: H / 2, side: 'on' }
  const to = { x: spineX(slot.y), y: slot.y }
  const voice = VOICES.find((v) => v.id === beat.from)
  if (!voice) {
    const y = Math.max(0, slot.y - 130)
    return { from: { x: spineX(y), y }, via: null, to, color: PAGE_COLOR, start }
  }
  const from = { x: NODE_X + 20, y: voice.y }
  return { from, via: { x: (from.x + to.x) / 2, y: voice.y }, to, color: voice.color, start }
}

function pointOn(flight: Flight, t: number): Point {
  const { from, via, to } = flight
  if (!via) {
    const y = from.y + (to.y - from.y) * t
    return { x: spineX(y), y }
  }
  const u = 1 - t
  return {
    x: u * u * from.x + 2 * u * t * via.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * via.y + t * t * to.y
  }
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Faint dust drifting over the band, fixed so server and client agree. */
const DUST = Array.from({ length: 26 }, (_, i) => ({
  x: (i * 211) % W,
  y: (i * 137 + 40) % H,
  phase: i * 1.7
}))

function draw(ctx: CanvasRenderingContext2D, now: number, flights: Flight[], ripples: Ripple[], c: Palette): void {
  ctx.clearRect(0, 0, W, H)

  for (const d of DUST) {
    const drift = Math.sin(now / 2400 + d.phase)
    ctx.globalAlpha = 0.22 + 0.14 * drift
    ctx.fillStyle = c['--accent']
    ctx.beginPath()
    ctx.arc(d.x + 6 * drift, d.y + 4 * Math.cos(now / 3100 + d.phase), 1.3, 0, Math.PI * 2)
    ctx.fill()
  }

  // Each voice's faint path to the page.
  ctx.setLineDash([2, 5])
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.45
  ctx.strokeStyle = c['--faint']
  for (const v of VOICES) {
    ctx.beginPath()
    ctx.moveTo(NODE_X + 22, v.y)
    ctx.quadraticCurveTo((NODE_X + spineX(v.y)) / 2, v.y, spineX(v.y), v.y)
    ctx.stroke()
  }
  ctx.setLineDash([])

  ctx.globalAlpha = 0.7
  ctx.strokeStyle = c['--faint']
  ctx.lineWidth = 1.2
  ctx.beginPath()
  for (let y = 0; y <= H; y += 6) {
    if (y === 0) ctx.moveTo(spineX(y), y)
    else ctx.lineTo(spineX(y), y)
  }
  ctx.stroke()

  for (const slot of SLOTS) {
    const x = spineX(slot.y)
    if (slot.side === 'right') {
      ctx.globalAlpha = 0.55
      ctx.strokeStyle = c['--faint']
      ctx.beginPath()
      ctx.moveTo(x, slot.y)
      ctx.lineTo(cardLeft(slot), slot.y)
      ctx.stroke()
    }
    ctx.globalAlpha = 0.8
    ctx.fillStyle = c['--faint']
    ctx.beginPath()
    ctx.arc(x, slot.y, 2.6, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const r of ripples) {
    const t = (now - r.start) / 700
    if (t < 0 || t > 1) continue
    ctx.strokeStyle = c[r.color]
    ctx.globalAlpha = 1 - t
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(r.at.x, r.at.y, 4 + 22 * ease(t), 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  for (const f of flights) {
    const t = (now - f.start) / TRAVEL_MS
    if (t < 0 || t > 1) continue
    // A short tail of fading dots behind the head.
    for (let k = 9; k >= 0; k--) {
      const p = pointOn(f, ease(Math.max(0, t - k * 0.025)))
      ctx.globalAlpha = k === 0 ? 1 : 0.5 * (1 - k / 10)
      ctx.fillStyle = c[f.color]
      ctx.shadowColor = c[f.color]
      ctx.shadowBlur = k === 0 ? 12 : 0
      ctx.beginPath()
      ctx.arc(p.x, p.y, k === 0 ? 3.4 : 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.shadowBlur = 0
  }
  ctx.globalAlpha = 1
}

const pct = (value: number, of: number): string => `${String((value / of) * 100)}%`

/** Inline position plus the `--c` color the stylesheet tints with. */
type Placed = CSSProperties & { '--c': string }

const place = (x: number, y: number, color: Token): Placed => ({ left: pct(x, W), top: pct(y, H), '--c': `var(${color})` })

/**
 * The hero's picture: voices on the left flow onto a page and land as transcript lines, speaker
 * labels, action items and a saved file. Decorative; the copy beside it says the same in words.
 */
export function HeroGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [cards, setCards] = useState(() => FIRST.map((card) => ({ card, n: 0 })))
  const [speaking, setSpeaking] = useState<Voice | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
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
    let palette = readPalette(canvas)
    // The tokens change with the OS theme; read them again and redraw.
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = (): void => {
      palette = readPalette(canvas)
      draw(ctx, performance.now(), flights, ripples, palette)
    }
    scheme.addEventListener('change', retheme)

    const fit = (): void => {
      const scale = (canvas.clientWidth / W) * window.devicePixelRatio
      canvas.width = Math.round(W * scale)
      canvas.height = Math.round(H * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      draw(ctx, performance.now(), flights, ripples, palette)
    }

    const tick = (now: number): void => {
      draw(ctx, now, flights, ripples, palette)
      frame = visible ? requestAnimationFrame(tick) : 0
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
      setSpeaking(next.from === 'page' ? null : next.from)
      later(TRAVEL_MS, () => {
        ripples.push({ at: flight.to, color: flight.color, start: performance.now() })
        if (ripples.length > 4) ripples.shift()
        setSpeaking(null)
        setCards((all) => all.map((c, i) => (i === next.slot ? { card: next.card, n: c.n + 1 } : c)))
        setFresh(next.slot)
        later(1400, () => {
          setFresh((slot) => (slot === next.slot ? null : slot))
        })
      })
    }

    const resize = new ResizeObserver(fit)
    resize.observe(canvas)
    if (still) {
      return () => {
        resize.disconnect()
        scheme.removeEventListener('change', retheme)
      }
    }

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
      scheme.removeEventListener('change', retheme)
      seen.disconnect()
      cancelAnimationFrame(frame)
      for (const id of timers) window.clearTimeout(id)
    }
  }, [])

  return (
    <div className={styles.graph} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
      {VOICES.map((v) => (
        <div
          key={v.id}
          className={cx(styles.voice, speaking === v.id && styles.speaking)}
          style={place(NODE_X, v.y, v.color)}
        >
          <span className={styles.dot}>{v.icon}</span>
          <span className={styles.voiceName}>{v.name}</span>
        </div>
      ))}
      {SLOTS.map((slot, i) => {
        const entry = cards[i]
        if (!entry) return null
        return (
          <div
            key={`${String(i)}-${String(entry.n)}`}
            className={cx(styles.card, entry.n > 0 && styles.enter, fresh === i && styles.fresh)}
            style={{ ...place(cardLeft(slot), slot.y, colorOf(entry.card.voice)), width: pct(CARD_W, W) }}
          >
            <span className={styles.kind}>{entry.card.kind}</span>
            <span className={styles.text}>{entry.card.text}</span>
          </div>
        )
      })}
    </div>
  )
}

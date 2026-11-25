'use client'

import { useEffect, useRef } from 'react'
import styles from './site.module.css'

// Stars are placed in fractions of the sky so it fills any width; seeded, so every visit sees
// the same sky and the server and client agree.
const FIELD = (() => {
  let seed = 11
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const tints = ['255, 255, 255', '255, 255, 255', '201, 212, 255', '255, 231, 196']
  return Array.from({ length: 420 }, () => ({
    x: rand(),
    y: rand(),
    r: 0.35 + rand() ** 3 * 1.3,
    alpha: 0.2 + rand() * 0.6,
    tint: tints[Math.floor(rand() * tints.length)] ?? '255, 255, 255',
    phase: rand() * Math.PI * 2,
    period: 900 + rand() * 2600
  }))
})()

/** Shooting stars: where each starts (fractions of the sky) and when, within one long cycle. */
const SHOTS = [
  { x: 0.92, y: 0.12, at: 0 },
  { x: 0.48, y: 0.06, at: 6500 },
  { x: 0.7, y: 0.55, at: 12000 }
]
const CYCLE_MS = 18000
const SHOT_MS = 900

const ease = (t: number): number => 1 - (1 - t) ** 3

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, now: number): void {
  ctx.clearRect(0, 0, w, h)
  for (const s of FIELD) {
    ctx.globalAlpha = s.alpha * (0.6 + 0.4 * Math.sin(now / s.period + s.phase))
    ctx.fillStyle = `rgb(${s.tint})`
    ctx.beginPath()
    ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  for (const shot of SHOTS) {
    const t = ((now - shot.at) % CYCLE_MS) / SHOT_MS
    if (t < 0 || t > 1) continue
    const head = { x: shot.x * w - 260 * ease(t), y: shot.y * h + 110 * ease(t) }
    const tail = { x: head.x + 90, y: head.y - 38 }
    const streak = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y)
    streak.addColorStop(0, 'rgba(255, 255, 255, 0.85)')
    streak.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.globalAlpha = Math.sin(Math.PI * t)
    ctx.strokeStyle = streak
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(head.x, head.y)
    ctx.lineTo(tail.x, tail.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** The hero's night sky: twinkling stars and the odd shooting star. Decorative. */
export function HeroSky() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let visible = false

    const fit = (): void => {
      const ratio = window.devicePixelRatio
      canvas.width = Math.round(canvas.clientWidth * ratio)
      canvas.height = Math.round(canvas.clientHeight * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      draw(ctx, canvas.clientWidth, canvas.clientHeight, performance.now())
    }
    const tick = (now: number): void => {
      draw(ctx, canvas.clientWidth, canvas.clientHeight, now)
      frame = visible ? requestAnimationFrame(tick) : 0
    }

    const resize = new ResizeObserver(fit)
    resize.observe(canvas)
    if (still) return () => resize.disconnect()

    const seen = new IntersectionObserver(([entry]) => {
      const was = visible
      visible = entry?.isIntersecting ?? false
      if (visible && !was) frame = requestAnimationFrame(tick)
    })
    seen.observe(canvas)
    return () => {
      resize.disconnect()
      seen.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  return <canvas ref={canvasRef} className={styles.sky} aria-hidden="true" />
}

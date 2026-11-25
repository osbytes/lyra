import { z } from 'zod'

/**
 * Where the main window was, saved in `userData/window-state.json`, and where to put it back.
 * Pure (no Electron), so the unit tests can check the clamping.
 */

export type Rect = { x: number; y: number; width: number; height: number }

export const WindowState = z.object({
  x: z.int(),
  y: z.int(),
  width: z.int().positive(),
  height: z.int().positive(),
  maximized: z.boolean()
})
export type WindowState = z.infer<typeof WindowState>

/** Less than this much of the window on a screen, and it is treated as off screen. */
const MIN_VISIBLE = 64

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * `saved` moved and shrunk to fit inside the work area it overlaps most, or null when it isn't
 * meaningfully on any connected screen (a monitor was unplugged): the caller then uses its
 * default size and lets the OS place it.
 */
export function fitToScreens(saved: Rect, workAreas: readonly Rect[], min: { width: number; height: number }): Rect | null {
  let best: Rect | null = null
  let bestArea = 0
  for (const area of workAreas) {
    const shared = overlap(saved, area)
    if (shared > bestArea) {
      best = area
      bestArea = shared
    }
  }
  if (!best || bestArea < MIN_VISIBLE * MIN_VISIBLE) return null
  const width = Math.max(Math.min(saved.width, best.width), Math.min(min.width, best.width))
  const height = Math.max(Math.min(saved.height, best.height), Math.min(min.height, best.height))
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width)
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

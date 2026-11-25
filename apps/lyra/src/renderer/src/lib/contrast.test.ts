import { describe, expect, it } from 'vitest'

/** WCAG 2 contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    const [r = 0, g = 0, b = 0] = channels.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    )
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

// Pairs from assets/styles.css. Change a token there, change it here.
describe('theme contrast', () => {
  it('reads white text on destructive buttons (--accent-text on --danger-fill)', () => {
    expect(contrast('#ffffff', '#c81e1e')).toBeGreaterThanOrEqual(4.5) // light
    expect(contrast('#ffffff', '#b91c1c')).toBeGreaterThanOrEqual(4.5) // dark
  })

  it('shows input edges (--border-input on --surface, WCAG 1.4.11)', () => {
    expect(contrast('#8a8a98', '#ffffff')).toBeGreaterThanOrEqual(3) // light
    expect(contrast('#73737f', '#1e1e24')).toBeGreaterThanOrEqual(3) // dark
  })

  it('keeps text readable on find highlights (--find-match, --find-current)', () => {
    expect(contrast('#18181f', '#fcefb4')).toBeGreaterThanOrEqual(4.5) // light: --text on match
    expect(contrast('#ececf1', '#5c4d12')).toBeGreaterThanOrEqual(4.5) // dark: --text on match
    expect(contrast('#18181f', '#f59e0b')).toBeGreaterThanOrEqual(4.5) // --find-current-text
  })

  it('agrees with known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    // The old dark destructive button, white on --danger #f87171, failed.
    expect(contrast('#ffffff', '#f87171')).toBeLessThan(4.5)
  })
})

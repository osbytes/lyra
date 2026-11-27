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
    expect(contrast('#ffffff', '#b42318')).toBeGreaterThanOrEqual(4.5) // light
    expect(contrast('#ffffff', '#b42318')).toBeGreaterThanOrEqual(4.5) // dark
  })

  it('shows input edges (--border-input on --surface, WCAG 1.4.11)', () => {
    expect(contrast('#858a9c', '#ffffff')).toBeGreaterThanOrEqual(3) // light
    expect(contrast('#6e7387', '#181a21')).toBeGreaterThanOrEqual(3) // dark
  })

  it('keeps text readable on find highlights (--find-match, --find-current)', () => {
    expect(contrast('#16171d', '#ffe38a')).toBeGreaterThanOrEqual(4.5) // light: --text on match
    expect(contrast('#ecedf3', '#5a480c')).toBeGreaterThanOrEqual(4.5) // dark: --text on match
    expect(contrast('#16171d', '#f59e0b')).toBeGreaterThanOrEqual(4.5) // --find-current-text
  })

  it('reads tertiary text on every ground (--text-subtle on --bg and --surface)', () => {
    expect(contrast('#626678', '#f6f6f9')).toBeGreaterThanOrEqual(4.5) // light canvas
    expect(contrast('#626678', '#ffffff')).toBeGreaterThanOrEqual(4.5) // light surface
    expect(contrast('#9195a7', '#111217')).toBeGreaterThanOrEqual(4.5) // dark canvas
    expect(contrast('#9195a7', '#181a21')).toBeGreaterThanOrEqual(4.5) // dark surface
  })

  it('reads labels on the accent (--accent-text on --accent)', () => {
    expect(contrast('#ffffff', '#3e45be')).toBeGreaterThanOrEqual(4.5) // light
    expect(contrast('#0e1030', '#8f96ff')).toBeGreaterThanOrEqual(4.5) // dark
    expect(contrast('#000000', '#3fe0ff')).toBeGreaterThanOrEqual(4.5) // high contrast
  })

  it('reads provenance and status chips on their soft grounds', () => {
    expect(contrast('#0b6e66', '#dff3f0')).toBeGreaterThanOrEqual(4.5) // local, light
    expect(contrast('#8b3fbf', '#f3e8fa')).toBeGreaterThanOrEqual(4.5) // cloud, light
    expect(contrast('#d11f3a', '#fde9ec')).toBeGreaterThanOrEqual(4.5) // recording, light
    expect(contrast('#3cc7b8', '#0f2e2b')).toBeGreaterThanOrEqual(4.5) // local, dark
    expect(contrast('#c78bf0', '#2c1c38')).toBeGreaterThanOrEqual(4.5) // cloud, dark
  })

  it('agrees with known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    // The old dark destructive button, white on --danger #f87171, failed.
    expect(contrast('#ffffff', '#f87171')).toBeLessThan(4.5)
  })
})

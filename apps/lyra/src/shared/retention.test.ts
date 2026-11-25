import { describe, expect, it } from 'vitest'
import { audioExpired, isStricterRetention, retentionCutoff } from './retention'

describe('isStricterRetention', () => {
  it('orders forever, days and until-transcribed', () => {
    expect(isStricterRetention(null, 30)).toBe(true)
    expect(isStricterRetention(30, 7)).toBe(true)
    expect(isStricterRetention(7, 0)).toBe(true)
    expect(isStricterRetention(7, 30)).toBe(false)
    expect(isStricterRetention(30, null)).toBe(false)
    expect(isStricterRetention(null, null)).toBe(false)
    expect(isStricterRetention(30, 30)).toBe(false)
  })
})

describe('retentionCutoff', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  it('is null when the sweep deletes nothing', () => {
    expect(retentionCutoff(null, now)).toBeNull()
    expect(retentionCutoff(0, now)).toBeNull()
  })

  it('is `days` before now', () => {
    expect(retentionCutoff(7, now)).toBe(Date.parse('2026-11-18T12:00:00Z'))
  })
})

describe('audioExpired', () => {
  const cutoff = Date.parse('2026-11-18T12:00:00Z')
  it('expires audio that ended before the cutoff, never an unreadable date', () => {
    expect(audioExpired('2026-11-01T00:00:00Z', cutoff)).toBe(true)
    expect(audioExpired('2026-11-20T00:00:00Z', cutoff)).toBe(false)
    expect(audioExpired('not a date', cutoff)).toBe(false)
  })
})

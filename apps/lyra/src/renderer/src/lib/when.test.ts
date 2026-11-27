import { describe, expect, it } from 'vitest'
import { rowTime } from './when'

// Local times throughout, so the test means the same in every time zone.
const now = new Date(2026, 10, 26, 15, 30) // Thu 26 Nov 2026, 15:30

describe('rowTime', () => {
  it('shows the clock time for today', () => {
    expect(rowTime(new Date(2026, 10, 26, 10, 2).toISOString(), now)).toBe('10:02')
    expect(rowTime(new Date(2026, 10, 26, 0, 0).toISOString(), now)).toBe('00:00')
  })

  it('shows the weekday within the last week', () => {
    expect(rowTime(new Date(2026, 10, 25, 23, 59).toISOString(), now)).toBe('Wed')
    expect(rowTime(new Date(2026, 10, 20, 9, 0).toISOString(), now)).toBe('Fri')
  })

  it('shows the date for anything older this year, and the year before that', () => {
    expect(rowTime(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe('2 Nov')
    expect(rowTime(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe('31 Dec 2025')
  })

  it('shows nothing for a date it cannot read', () => {
    expect(rowTime('not a date', now)).toBe('')
  })
})

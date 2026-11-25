import { describe, expect, it } from 'vitest'
import { backoffMs, planResponse, progressThrottle, spaceShortfall, SPACE_MARGIN_BYTES } from './downloadPlan'

const TOTAL = 1000

describe('planResponse', () => {
  it('writes a fresh download, and starts over when a range request gets the whole file', () => {
    expect(planResponse(200, null, 0, TOTAL)).toEqual({ action: 'append' })
    expect(planResponse(200, null, 400, TOTAL)).toEqual({ action: 'restart' })
  })

  it('continues only the range asked for, of the pinned file', () => {
    expect(planResponse(206, 'bytes 400-999/1000', 400, TOTAL)).toEqual({ action: 'append' })
    expect(planResponse(206, 'bytes 400-999/*', 400, TOTAL)).toEqual({ action: 'append' })
    expect(planResponse(206, 'bytes 0-999/1000', 400, TOTAL)).toEqual({ action: 'discard' })
    expect(planResponse(206, 'bytes 400-1999/2000', 400, TOTAL)).toEqual({ action: 'discard' })
    expect(planResponse(206, null, 400, TOTAL)).toEqual({ action: 'discard' })
    expect(planResponse(416, null, 400, TOTAL)).toEqual({ action: 'discard' })
  })

  it('retries passing failures and gives up on the rest', () => {
    expect(planResponse(503, null, 0, TOTAL).action).toBe('retry')
    expect(planResponse(429, null, 0, TOTAL).action).toBe('retry')
    expect(planResponse(404, null, 0, TOTAL).action).toBe('fail')
    expect(planResponse(403, null, 400, TOTAL).action).toBe('fail')
  })
})

describe('backoffMs', () => {
  it('doubles and is capped', () => {
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([2000, 4000, 8000, 16000])
    expect(backoffMs(10)).toBe(30_000)
  })
})

describe('progressThrottle', () => {
  it('passes at most once per interval, and always when forced', () => {
    let now = 0
    const throttle = progressThrottle(200, () => now)
    expect(throttle()).toBe(true)
    now = 50
    expect(throttle()).toBe(false)
    expect(throttle(true)).toBe(true)
    now = 100
    expect(throttle()).toBe(false)
    now = 300
    expect(throttle()).toBe(true)
  })
})

describe('spaceShortfall', () => {
  it('asks for the download plus a margin', () => {
    expect(spaceShortfall(10 * SPACE_MARGIN_BYTES, 100)).toBe(0)
    expect(spaceShortfall(SPACE_MARGIN_BYTES, 100)).toBe(100)
  })
})

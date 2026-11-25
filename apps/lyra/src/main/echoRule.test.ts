import { describe, expect, it } from 'vitest'
import { countBetween, isEchoOnly } from './echoRule'

describe('isEchoOnly', () => {
  it('keeps a quick reply when the far end was silent', () => {
    expect(isEchoOnly(0.2, 0)).toBe(false)
    expect(isEchoOnly(0, 0.05)).toBe(false)
  })

  it('drops a mic chunk with little own speech while the far end talked', () => {
    expect(isEchoOnly(0.2, 1.5)).toBe(true)
    expect(isEchoOnly(0, 0.1)).toBe(true)
  })

  it('keeps the user talking over the far end', () => {
    expect(isEchoOnly(0.4, 3)).toBe(false)
    expect(isEchoOnly(2, 3)).toBe(false)
  })
})

describe('countBetween', () => {
  it('counts sorted frame starts in a half-open range', () => {
    expect(countBetween([0, 512, 1024, 1536], 512, 1536)).toBe(2)
    expect(countBetween([], 0, 100)).toBe(0)
    expect(countBetween([0, 512], -1000, 0)).toBe(0)
  })
})

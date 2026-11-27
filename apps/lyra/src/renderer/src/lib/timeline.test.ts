import { describe, expect, it } from 'vitest'
import { axisStep, lineAt } from './timeline'

describe('axisStep', () => {
  it('picks the finest step with at most six marks', () => {
    expect(axisStep(5 * 60)).toBe(60) // 5 marks
    expect(axisStep(10 * 60)).toBe(120) // 5 marks; 1 min would give 10
    expect(axisStep(59 * 60)).toBe(600) // 5.9 marks
    expect(axisStep(62 * 60)).toBe(900) // 600 would give 6.2
    expect(axisStep(3 * 3600)).toBe(1800)
  })

  it('caps at an hour for very long sessions', () => {
    expect(axisStep(12 * 3600)).toBe(3600)
  })
})

describe('lineAt', () => {
  const lines = [
    { id: 'a', start: 0, end: 4 },
    { id: 'b', start: 5, end: 9 },
    { id: 'c', start: 12, end: 20 }
  ]

  it('finds the line spoken at a moment', () => {
    expect(lineAt(lines, 0)?.id).toBe('a')
    expect(lineAt(lines, 7)?.id).toBe('b')
    expect(lineAt(lines, 20)?.id).toBe('c')
  })

  it('is null in a pause, before the first line and after the last', () => {
    expect(lineAt(lines, 10)).toBeNull()
    expect(lineAt(lines, -1)).toBeNull()
    expect(lineAt(lines, 25)).toBeNull()
    expect(lineAt([], 3)).toBeNull()
  })
})

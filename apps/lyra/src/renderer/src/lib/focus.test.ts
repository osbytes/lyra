import { describe, expect, it } from 'vitest'
import { nextTrapIndex, radioIndex, rovingIndex } from './focus'

describe('nextTrapIndex', () => {
  it('wraps at both ends', () => {
    expect(nextTrapIndex(2, 3, false)).toBe(0)
    expect(nextTrapIndex(0, 3, true)).toBe(2)
    expect(nextTrapIndex(1, 3, false)).toBe(2)
    expect(nextTrapIndex(1, 3, true)).toBe(0)
  })

  it('brings focus back in from outside', () => {
    expect(nextTrapIndex(-1, 3, false)).toBe(0)
    expect(nextTrapIndex(-1, 3, true)).toBe(2)
  })

  it('has nowhere to go in an empty dialog', () => {
    expect(nextTrapIndex(-1, 0, false)).toBeNull()
  })
})

describe('rovingIndex', () => {
  it('moves one line and stops at the ends', () => {
    expect(rovingIndex('ArrowDown', 0, 3)).toBe(1)
    expect(rovingIndex('ArrowDown', 2, 3)).toBe(2)
    expect(rovingIndex('ArrowUp', 0, 3)).toBe(0)
    expect(rovingIndex('ArrowUp', 2, 3)).toBe(1)
  })

  it('jumps to the first and last line', () => {
    expect(rovingIndex('Home', 2, 5)).toBe(0)
    expect(rovingIndex('End', 0, 5)).toBe(4)
  })

  it('starts from the first line when none is focused', () => {
    expect(rovingIndex('ArrowDown', -1, 3)).toBe(0)
    expect(rovingIndex('ArrowUp', -1, 3)).toBe(0)
  })

  it('ignores other keys and empty lists', () => {
    expect(rovingIndex('Enter', 1, 3)).toBeNull()
    expect(rovingIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('radioIndex', () => {
  it('moves both ways and wraps', () => {
    expect(radioIndex('ArrowRight', 1, 2)).toBe(0)
    expect(radioIndex('ArrowDown', 0, 2)).toBe(1)
    expect(radioIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(radioIndex('ArrowUp', 2, 3)).toBe(1)
  })

  it('ignores keys that are not arrows, Home or End', () => {
    expect(radioIndex('Tab', 0, 2)).toBeNull()
    expect(radioIndex('End', 0, 3)).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { keyName } from './keys'

describe('keyName', () => {
  it('uses symbols on macOS', () => {
    expect(keyName('Enter', true)).toBe('↩')
    expect(keyName('Shift+Enter', true)).toBe('⇧↩')
    expect(keyName('Delete', true)).toBe('⌘⌫')
  })

  it('spells keys out elsewhere', () => {
    expect(keyName('Enter', false)).toBe('Enter')
    expect(keyName('Shift+Enter', false)).toBe('Shift+Enter')
    expect(keyName('Delete', false)).toBe('Del')
    expect(keyName('Esc', false)).toBe('Esc')
  })
})

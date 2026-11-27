import { describe, expect, it } from 'vitest'
import { monogram, speakerSlot } from './speakerTone'

describe('speakerSlot', () => {
  const speakers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('is the speaker position in the session', () => {
    expect(speakerSlot(speakers, 'a')).toBe(0)
    expect(speakerSlot(speakers, 'c')).toBe(2)
  })
  it('falls back to the first slot for an unknown id', () => {
    expect(speakerSlot(speakers, 'z')).toBe(0)
  })
})

describe('monogram', () => {
  it('takes the first and last initials of a name', () => {
    expect(monogram('Priya Anand')).toBe('PA')
    expect(monogram('Lena')).toBe('L')
    expect(monogram('Ama van der Berg')).toBe('AB')
  })
  it('uses the number of an unnamed speaker', () => {
    expect(monogram('Speaker 3')).toBe('3')
    expect(monogram('speaker 12')).toBe('12')
  })
  it('ignores a parenthetical and non-letters', () => {
    expect(monogram('Sam Rivera (me)')).toBe('SR')
    expect(monogram('Sofía Ramírez')).toBe('SR')
    expect(monogram('  ')).toBe('?')
  })
})

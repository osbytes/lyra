import { describe, expect, it } from 'vitest'
import { replacesToast } from './toast'

const undo = { text: 'Deleted “Standup”', action: { label: 'Undo', run: () => undefined } }
const copied = { text: 'Copied' }

describe('replacesToast', () => {
  it('fills an empty slot', () => {
    expect(replacesToast(null, copied)).toBe(true)
  })

  it('keeps an Undo toast over a plain notice', () => {
    expect(replacesToast(undo, copied)).toBe(false)
  })

  it('lets a newer action replace an older one, and anything replace a notice', () => {
    expect(replacesToast(undo, { ...undo, text: 'Deleted “Retro”' })).toBe(true)
    expect(replacesToast(copied, undo)).toBe(true)
    expect(replacesToast(copied, { text: 'Added to your notes' })).toBe(true)
  })
})

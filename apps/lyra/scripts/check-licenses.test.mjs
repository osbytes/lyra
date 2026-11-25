import { describe, expect, it } from 'vitest'
import { isAllowed } from './check-licenses.mjs'

describe('isAllowed', () => {
  it('accepts a permissive licence and refuses copyleft or a missing one', () => {
    expect(isAllowed('MIT')).toBe(true)
    expect(isAllowed('LGPL-3.0-or-later')).toBe(false)
    expect(isAllowed('UNKNOWN')).toBe(false)
    expect(isAllowed('')).toBe(false)
  })

  it('needs one allowed alternative of an OR', () => {
    expect(isAllowed('(AFL-2.1 OR BSD-3-Clause)')).toBe(true)
    expect(isAllowed('(GPL-2.0 OR LGPL-2.1)')).toBe(false)
  })

  it('needs every part of an AND', () => {
    expect(isAllowed('MIT AND ISC')).toBe(true)
    expect(isAllowed('(MIT AND GPL-3.0)')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('keeps a type size beside a text colour', () => {
    expect(cn('text-label text-text-3')).toBe('text-label text-text-3')
    expect(cn('text-body-sm font-semibold text-foreground')).toBe('text-body-sm font-semibold text-foreground')
  })

  it('lets a later size or colour win over an earlier one', () => {
    expect(cn('text-label', 'text-body')).toBe('text-body')
    expect(cn('text-text-3', 'text-destructive')).toBe('text-destructive')
  })
})

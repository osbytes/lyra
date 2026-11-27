import { describe, expect, it } from 'vitest'
import { MIN_SUMMARY_WORDS, worthSummarizing } from './notesWorth'

const words = (count: number): string => Array.from({ length: count }, (_, i) => `w${String(i)}`).join(' ')

describe('worthSummarizing', () => {
  it('skips a recording that barely says anything', () => {
    expect(worthSummarizing([{ text: 'Testing, testing, hello, hello.' }])).toBe(false)
    expect(worthSummarizing([])).toBe(false)
  })

  it('summarizes once enough is said, across lines', () => {
    expect(worthSummarizing([{ text: words(MIN_SUMMARY_WORDS - 1) }])).toBe(false)
    expect(worthSummarizing([{ text: words(25) }, { text: `  ${words(15)}  ` }])).toBe(true)
  })
})

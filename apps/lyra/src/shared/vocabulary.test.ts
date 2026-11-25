import { describe, expect, it } from 'vitest'
import { addTerms, dedupeTerms, MAX_PROMPT_CHARS, MAX_TERMS, Vocabulary, withVocabulary } from './vocabulary'

describe('dedupeTerms', () => {
  it('trims, collapses spaces and drops blanks and case-insensitive repeats', () => {
    expect(dedupeTerms([' Acme ', 'acme', '', 'Jane  Doe', 'ACME'])).toEqual(['Acme', 'Jane Doe'])
  })
})

describe('Vocabulary', () => {
  it('cleans a stored list', () => {
    expect(Vocabulary.parse([' Kubernetes', 'kubernetes', 'Siobhan'])).toEqual(['Kubernetes', 'Siobhan'])
  })

  it('refuses overlong terms and lists', () => {
    expect(Vocabulary.safeParse(['x'.repeat(61)]).success).toBe(false)
    expect(Vocabulary.safeParse(Array.from({ length: MAX_TERMS + 1 }, (_, i) => `t${String(i)}`)).success).toBe(false)
    expect(Vocabulary.safeParse('Acme').success).toBe(false)
  })
})

describe('addTerms', () => {
  it('splits a pasted list and keeps the first spelling', () => {
    expect(addTerms(['Acme'], 'acme, Kubernetes;\nSiobhan')).toEqual({
      status: 'added',
      terms: ['Acme', 'Kubernetes', 'Siobhan'],
      added: 2
    })
  })

  it('says why nothing was added', () => {
    expect(addTerms([], ' , ')).toEqual({ status: 'unchanged', reason: 'empty' })
    expect(addTerms(['Acme'], 'ACME')).toEqual({ status: 'unchanged', reason: 'duplicate' })
    expect(addTerms([], 'x'.repeat(61))).toEqual({ status: 'unchanged', reason: 'too-long' })
    const full = Array.from({ length: MAX_TERMS }, (_, i) => `t${String(i)}`)
    expect(addTerms(full, 'new')).toEqual({ status: 'unchanged', reason: 'full' })
  })
})

describe('withVocabulary', () => {
  it('leaves the prompt untouched with no terms', () => {
    expect(withVocabulary('earlier text', [])).toBe('earlier text')
    expect(withVocabulary('', [])).toBe('')
  })

  it('puts the terms before the context', () => {
    expect(withVocabulary('earlier text', ['Acme', 'Siobhan'])).toBe('Acme, Siobhan. earlier text')
    expect(withVocabulary('', ['Acme'])).toBe('Acme.')
  })

  it('caps the glossary, leaving out whole terms', () => {
    const terms = Array.from({ length: 50 }, (_, i) => `term-number-${String(i)}`)
    const prompt = withVocabulary('', terms)
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 1)
    expect(prompt.endsWith('.')).toBe(true)
    for (const kept of prompt.slice(0, -1).split(', ')) expect(terms).toContain(kept)
  })
})

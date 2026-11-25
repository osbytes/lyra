import { describe, expect, it } from 'vitest'
import { SearchQuery, hasFilters, parseSearchQuery } from './searchQuery'

describe('parseSearchQuery', () => {
  it('takes every kind of filter out of the words', () => {
    expect(parseSearchQuery('budget person:ana tag:Design after:2026-11 before:2026-12-01 review')).toEqual({
      text: 'budget review',
      people: ['ana'],
      tags: ['Design'],
      after: '2026-11',
      before: '2026-12-01'
    })
  })

  it('reads a quoted value with spaces', () => {
    const query = parseSearchQuery('speaker:"Speaker 2" roadmap')
    expect(query.people).toEqual(['Speaker 2'])
    expect(query.text).toBe('roadmap')
  })

  it('reads filter names in any case, and repeated filters', () => {
    const query = parseSearchQuery('TAG:a Tag:b')
    expect(query.tags).toEqual(['a', 'b'])
    expect(query.text).toBe('')
  })

  it('leaves a date filter that is not a date as words', () => {
    const query = parseSearchQuery('after:yesterday before:2026-1 plans')
    expect(query.after).toBeNull()
    expect(query.before).toBeNull()
    expect(query.text).toBe('after:yesterday before:2026-1 plans')
  })

  it('leaves an empty value as words', () => {
    const query = parseSearchQuery('tag:"" notes')
    expect(query.tags).toEqual([])
    expect(query.text).toBe('tag:"" notes')
  })

  it('only reads a filter at the start of a word', () => {
    const query = parseSearchQuery('mytag:x email:a@b.c')
    expect(query.tags).toEqual([])
    expect(query.text).toBe('mytag:x email:a@b.c')
  })

  it('always gives a value the schema accepts', () => {
    expect(SearchQuery.safeParse(parseSearchQuery('a tag:b person:"c d" after:2026')).success).toBe(true)
  })
})

describe('hasFilters', () => {
  it('is true only when a filter was read', () => {
    expect(hasFilters(parseSearchQuery('just words'))).toBe(false)
    expect(hasFilters(parseSearchQuery('after:2026'))).toBe(true)
    expect(hasFilters(parseSearchQuery('person:ana'))).toBe(true)
  })
})

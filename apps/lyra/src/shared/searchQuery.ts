import { z } from 'zod'

/**
 * What someone types into search: words, plus filters written as `name:value`.
 *
 *   person:ana  speaker:"Speaker 2"   sessions where that speaker (or saved person) talks
 *   tag:design                        sessions with that tag
 *   after:2026-11-01  before:2026-12  sessions that started in that range (dates, by prefix)
 *
 * Parsed in main (the IPC still carries the plain string), and shared so the window can show
 * the filters it understood.
 */

export const SearchQuery = z.object({
  /** The words to match, filters removed. */
  text: z.string(),
  /** Speaker or person names, each a case-insensitive prefix. All must have spoken. */
  people: z.array(z.string()),
  tags: z.array(z.string()),
  /** ISO date prefixes: `after` is inclusive, `before` exclusive. */
  after: z.string().nullable(),
  before: z.string().nullable()
})
export type SearchQuery = z.infer<typeof SearchQuery>

const FILTER = /(^|\s)(person|speaker|tag|after|before):(?:"([^"]*)"|(\S+))/gi
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/

export function parseSearchQuery(input: string): SearchQuery {
  const query: SearchQuery = { text: '', people: [], tags: [], after: null, before: null }
  const text = input.replace(FILTER, (whole, lead: string, name: string, quoted?: string, bare?: string) => {
    const value = (quoted ?? bare ?? '').trim()
    if (!value) return whole
    switch (name.toLowerCase()) {
      case 'person':
      case 'speaker':
        query.people.push(value)
        return lead
      case 'tag':
        query.tags.push(value)
        return lead
      case 'after':
        if (!DATE.test(value)) return whole
        query.after = value
        return lead
      case 'before':
        if (!DATE.test(value)) return whole
        query.before = value
        return lead
      default:
        return whole
    }
  })
  query.text = text.replace(/\s+/g, ' ').trim()
  return query
}

export function hasFilters(query: SearchQuery): boolean {
  return query.people.length > 0 || query.tags.length > 0 || query.after !== null || query.before !== null
}

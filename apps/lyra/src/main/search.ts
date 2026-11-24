import { normalizeTag } from '../shared/sessionDoc'
import { hasFilters, parseSearchQuery } from '../shared/searchQuery'
import type { SearchHit, SearchMatch } from '../shared/types'
import type { PassageHit } from './searchIndex/protocol'
import { searchIndex } from './searchIndex/service'

/** Sessions returned per query. */
const MAX_HITS = 30
/** Characters of context around the best match in a long paragraph. */
const SNIPPET_CONTEXT = 70

/** A matched range of a passage, `[start, end)`. */
type Range = [number, number]

/** The passage text without the index's match markers (\u0001 … \u0002), and where they were. */
export function unmark(marked: string): { text: string; ranges: Range[] } {
  let text = ''
  const ranges: Range[] = []
  let open: number | null = null
  for (const char of marked) {
    if (char === '\u0001') open = text.length
    else if (char === '\u0002') {
      if (open !== null && text.length > open) ranges.push([open, text.length])
      open = null
    } else text += char
  }
  return { text, ranges }
}

/** Cuts long text to a window around its longest match, keeping every match inside it. */
function partsOf(text: string, ranges: readonly Range[]): SearchMatch['parts'] {
  // Neighbouring matches ("contr", "st") read better as one mark per word.
  const merged: Range[] = []
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && range[0] - last[1] <= 2 && !/\s/.test(text.slice(last[1], range[0]))) {
      last[1] = Math.max(last[1], range[1])
    } else merged.push([range[0], range[1]])
  }
  const longest = [...merged].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
  let from = 0
  let to = text.length
  if (longest && text.length > SNIPPET_CONTEXT * 2 + 20) {
    from = Math.max(0, longest[0] - SNIPPET_CONTEXT)
    to = Math.min(text.length, longest[1] + SNIPPET_CONTEXT)
  }
  const parts: SearchMatch['parts'] = []
  let at = from
  for (const [start, end] of merged) {
    if (end <= at || start >= to) continue
    const s = Math.max(start, at)
    const e = Math.min(end, to)
    if (s > at) parts.push({ text: text.slice(at, s), hit: false })
    parts.push({ text: text.slice(s, e), hit: true })
    at = e
  }
  if (at < to) parts.push({ text: text.slice(at, to), hit: false })
  const flat = parts.map((part) => ({ ...part, text: part.text.replace(/\s+/g, ' ') }))
  const first = flat[0]
  const last = flat.at(-1)
  if (from > 0 && first) first.text = `…${first.text.trimStart()}`
  if (to < text.length && last) last.text = `${last.text.trimEnd()}…`
  return flat
}

function matchOf(passage: PassageHit): SearchMatch {
  const { text, ranges } = unmark(passage.marked)
  return {
    field: passage.field,
    parts: partsOf(text, ranges),
    speaker: passage.speaker,
    start: passage.start,
    line: passage.segmentId
  }
}

/**
 * Search over the index (searchIndex/query.ts): words, stems, close spellings and parts of
 * words across titles, tags, meeting notes, notes and transcript lines, narrowed by `person:`,
 * `tag:`, `after:` and `before:` filters. Sessions come best match first, each with its best
 * few matches.
 */
export async function searchSessions(input: string): Promise<SearchHit[]> {
  const parsed = parseSearchQuery(input)
  const query = { ...parsed, tags: parsed.tags.map(normalizeTag).filter(Boolean) }
  if (!query.text && !hasFilters(query)) return []
  const hits = await searchIndex(query, MAX_HITS)
  return hits.map(({ relevance, passages, ...summary }) => ({
    ...summary,
    score: relevance,
    matches: passages.map(matchOf)
  }))
}

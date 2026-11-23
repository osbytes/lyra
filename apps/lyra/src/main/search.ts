import Fuse, { type FuseResult, type RangeTuple } from 'fuse.js'
import type { PageSummary, SearchField, SearchHit, SearchMatch } from '../shared/types'
import { log } from './log'
import { listSessions, readSession } from './sessionStore'

/** Sessions returned per query, and matches kept per session. */
const MAX_HITS = 30
const MAX_MATCHES = 5
/** Characters of context around the best match in a long paragraph. */
const SNIPPET_CONTEXT = 70
/** Titles and tags rank above a body match of the same quality. */
const FIELD_BOOST: Record<SearchField, number> = {
  title: 0.5,
  tags: 0.6,
  summary: 0.9,
  notes: 1,
  transcript: 1
}

type Entry = {
  session: string
  field: SearchField
  text: string
  speaker: string | null
  start: number | null
  line: string | null
}

const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n|\n(?=[-*•—]\s)/)
    .map((part) => part.trim())
    .filter(Boolean)

/** Every searchable piece of one session: title, tags, paragraphs and transcript lines. */
async function entriesOf(page: PageSummary): Promise<Entry[]> {
  const s = await readSession(page.id)
  const base = { session: page.id, speaker: null, start: null, line: null }
  const names = new Map(s.speakers.map((speaker) => [speaker.id, speaker.name]))
  return [
    { ...base, field: 'title' as const, text: page.title },
    ...s.tags.map((tag) => ({ ...base, field: 'tags' as const, text: tag })),
    ...paragraphs(s.summary).map((text) => ({ ...base, field: 'summary' as const, text })),
    ...paragraphs(s.notes).map((text) => ({ ...base, field: 'notes' as const, text })),
    ...s.transcript
      .filter((line) => line.text.trim())
      .map((line) => ({
        session: page.id,
        field: 'transcript' as const,
        text: line.text.trim(),
        speaker: line.cluster ? (names.get(line.cluster) ?? null) : null,
        start: line.start,
        line: line.id
      }))
  ]
}

/** Entries per session, rebuilt only for sessions edited since they were indexed. */
const cache = new Map<string, { updatedAt: string; entries: Entry[] }>()
let index: { key: string; fuse: Fuse<Entry> } | null = null

async function fuseFor(pages: PageSummary[]): Promise<Fuse<Entry>> {
  const key = pages.map((page) => `${page.id}@${page.updatedAt}`).join('|')
  if (index?.key === key) return index.fuse
  const live = new Set(pages.map((page) => page.id))
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  for (const page of pages) {
    if (cache.get(page.id)?.updatedAt === page.updatedAt) continue
    try {
      cache.set(page.id, { updatedAt: page.updatedAt, entries: await entriesOf(page) })
    } catch (error) {
      log('search', 'skipped unreadable session', { id: page.id, error: String(error) })
    }
  }
  const fuse = new Fuse([...cache.values()].flatMap((value) => value.entries), {
    keys: ['text'],
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true,
    ignoreDiacritics: true,
    useExtendedSearch: true,
    threshold: 0.32,
    minMatchCharLength: 2
  })
  index = { key, fuse }
  return fuse
}

/**
 * Plain words only: extended search ANDs space-separated fuzzy terms, and its operators
 * (`'`, `=`, `!`, `^`, `$`, `|`) would surprise someone typing a note.
 */
function queryOf(input: string): string {
  return input
    .split(/\s+/)
    .map((word) => word.replace(/^[!'=^]+|\$+$/g, '').replace(/\|/g, ''))
    .filter((word) => word.length > 0)
    .join(' ')
}

/** Cuts long text to a window around its longest match, keeping every match inside it. */
function partsOf(text: string, ranges: readonly RangeTuple[]): SearchMatch['parts'] {
  // Fuzzy matches come back in fragments ("contr", "st"); one mark per word reads better.
  const sorted: RangeTuple[] = []
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = sorted.at(-1)
    if (last && range[0] - last[1] <= 3 && !/\s/.test(text.slice(last[1] + 1, range[0]))) {
      last[1] = Math.max(last[1], range[1])
    } else sorted.push([range[0], range[1]])
  }
  const longest = [...sorted].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
  let from = 0
  let to = text.length
  if (longest && text.length > SNIPPET_CONTEXT * 2 + 20) {
    from = Math.max(0, longest[0] - SNIPPET_CONTEXT)
    to = Math.min(text.length, longest[1] + 1 + SNIPPET_CONTEXT)
  }
  const parts: SearchMatch['parts'] = []
  let at = from
  for (const [start, end] of sorted) {
    if (end < at || start >= to) continue
    const s = Math.max(start, at)
    const e = Math.min(end + 1, to)
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

function matchOf(result: FuseResult<Entry>): SearchMatch {
  const { item } = result
  const ranges = result.matches?.flatMap((match) => match.indices) ?? []
  return {
    field: item.field,
    parts: partsOf(item.text, ranges),
    speaker: item.speaker,
    start: item.start,
    line: item.line
  }
}

/**
 * Fuzzy search (Fuse.js) over every session's title, tags, meeting notes, notes and transcript
 * lines. Sessions are ranked by their best match; each carries its best few matches.
 */
export async function searchSessions(input: string): Promise<SearchHit[]> {
  const query = queryOf(input)
  if (!query) return []
  const pages = await listSessions()
  const fuse = await fuseFor(pages)
  const bySession = new Map<string, { score: number; results: FuseResult<Entry>[] }>()
  for (const result of fuse.search(query)) {
    const score = (result.score ?? 1) * FIELD_BOOST[result.item.field]
    const group = bySession.get(result.item.session)
    if (!group) bySession.set(result.item.session, { score, results: [result] })
    else {
      group.score = Math.min(group.score, score)
      if (group.results.length < MAX_MATCHES) group.results.push(result)
    }
  }
  const summaries = new Map(pages.map((page) => [page.id, page]))
  return [...bySession]
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, MAX_HITS)
    .flatMap(([id, group]): SearchHit[] => {
      const page = summaries.get(id)
      if (!page) return []
      // The title row already shows the title, so a title match adds no line of its own.
      const matches = group.results.filter((r) => r.item.field !== 'title').map(matchOf)
      return [{ ...page, score: group.score, matches }]
    })
}

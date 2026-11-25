import type { Client, InStatement } from '@libsql/client'
import { z } from 'zod'
import type { SearchQuery } from '../../shared/searchQuery'
import type { Embedder } from './embedder'
import type { PassageHit, SessionHit } from './protocol'

/**
 * Keyword search over the index (docs/SEARCH-INDEX.md, Querying). Each word matches as a word
 * or stem prefix (FTS5, porter), or as a close spelling of a word the notes contain; passages
 * that hold every word rank by bm25 and the field they're in. Words of three letters or more
 * also match inside longer words (the trigram table), ranked lower. Filters narrow the sessions
 * first. With an embedder, the chunks closest in meaning are found too, and both lists are
 * merged by reciprocal rank fusion.
 */

/** Titles and tags outrank a body match of the same quality. */
const FIELD_WEIGHT: Record<PassageHit['field'], number> = {
  title: 3,
  tags: 2.5,
  summary: 1.2,
  notes: 1,
  transcript: 1
}
/** A match inside a word ("illo" in "Dillon") counts for less than a word match. */
const PARTIAL_WEIGHT = 0.5
const MAX_PASSAGES = 5
/**
 * Passages read per query, before grouping by session. They're cut by the same score they're
 * ranked by (fieldWeightSql), so a common word can't push a title match out.
 */
const PASSAGE_LIMIT = 2000
const MAX_CORRECTIONS = 3

/** FIELD_WEIGHT as SQL over `p.field`; the weights are numbers we wrote, not input. */
const fieldWeightSql = `CASE p.field ${Object.entries(FIELD_WEIGHT)
  .map(([field, weight]) => `WHEN '${field}' THEN ${String(weight)}`)
  .join(' ')} ELSE 1 END`

/** Folded the way the FTS tables fold (remove_diacritics), so query and index agree. */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Query words: letters and digits only, so nothing in them is FTS5 syntax. */
export function wordsOf(text: string): string[] {
  return [...fold(text).matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0])
}

// --- Spelling -----------------------------------------------------------------------

type Term = { term: string; docs: number }

/** The index's words, read once and dropped whenever the index changes. */
let vocabulary: Term[] | null = null

export function invalidateVocabulary(): void {
  vocabulary = null
}

async function vocabularyOf(db: Client): Promise<Term[]> {
  if (vocabulary) return vocabulary
  const result = await db.execute('SELECT term, doc FROM passages_vocab')
  const Row = z.object({ term: z.string(), doc: z.number() })
  vocabulary = result.rows.map((row) => {
    const { term, doc } = Row.parse(row)
    return { term, docs: doc }
  })
  return vocabulary
}

/** Optimal string alignment distance (a swap of two letters is one edit), or `limit + 1`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] ?? 0) + 1)
      }
      current.push(value)
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
    before = previous
    previous = current
  }
  return previous[b.length] ?? limit + 1
}

/**
 * Words the notes contain that `word` is probably a misspelling of. The index holds stems, so
 * a stem is also compared with the word cut to its length: "meetign" finds "meet".
 */
function correctionsOf(word: string, terms: Term[]): string[] {
  if (word.length < 4) return []
  const limit = word.length >= 7 ? 2 : 1
  const close = terms.filter(({ term }) => {
    if (term.length < 3) return false
    if (editDistance(word, term, limit) <= limit) return true
    return word.length > term.length && word.length - term.length <= 3 &&
      editDistance(word.slice(0, term.length), term, limit - 1) <= limit - 1
  })
  return close
    .sort((a, b) => b.docs - a.docs)
    .slice(0, MAX_CORRECTIONS)
    .map(({ term }) => term)
}

async function matchesAnything(db: Client, match: string): Promise<boolean> {
  const result = await db.execute({ sql: 'SELECT 1 FROM passages_fts WHERE passages_fts MATCH ? LIMIT 1', args: [match] })
  return result.rows.length > 0
}

// --- Filters ------------------------------------------------------------------------

const likePrefix = (value: string): string => `${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** SQL conditions on `s` (sessions) for the query's filters. */
function filtersOf(query: SearchQuery): { sql: string; args: string[] } {
  const parts: string[] = []
  const args: string[] = []
  for (const name of query.people) {
    parts.push(`s.id IN (SELECT sp.session_id FROM speakers sp LEFT JOIN people pe ON pe.id = sp.person_id
      WHERE sp.name LIKE ? ESCAPE '\\' OR pe.name LIKE ? ESCAPE '\\')`)
    args.push(likePrefix(name), likePrefix(name))
  }
  for (const tag of query.tags) {
    parts.push('s.id IN (SELECT session_id FROM tags WHERE tag = ?)')
    args.push(tag)
  }
  if (query.after) {
    parts.push('s.started_at >= ?')
    args.push(query.after)
  }
  if (query.before) {
    parts.push('s.started_at < ?')
    args.push(query.before)
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', args }
}

// --- Matching -----------------------------------------------------------------------

const PassageRow = z.object({
  id: z.number(),
  session: z.string(),
  field: z.enum(['title', 'tags', 'summary', 'notes', 'transcript']),
  segment_id: z.string().nullable(),
  start_sec: z.number().nullable(),
  speaker: z.string().nullable(),
  marked: z.string(),
  rank: z.number()
})

function passageQuery(table: 'passages_fts' | 'passages_tri', match: string, query: SearchQuery): InStatement {
  const filters = filtersOf(query)
  return {
    sql: `SELECT p.id, p.session_id AS session, p.field, p.segment_id, p.start_sec, sp.name AS speaker,
        highlight(${table}, 0, char(1), char(2)) AS marked, bm25(${table}) AS rank
      FROM ${table}
      JOIN passages p ON p.id = ${table}.rowid
      JOIN sessions s ON s.id = p.session_id
      LEFT JOIN speakers sp ON sp.session_id = p.session_id AND sp.cluster = p.cluster
      WHERE ${table} MATCH ? AND ${filters.sql}
      ORDER BY ${fieldWeightSql} + max(0, -bm25(${table})) DESC LIMIT ${String(PASSAGE_LIMIT)}`,
    args: [match, ...filters.args]
  }
}

async function matchPassages(db: Client, query: SearchQuery, words: string[]): Promise<Map<number, PassageHit & { session: string }>> {
  const terms = await vocabularyOf(db)
  const groups: string[] = []
  for (const word of words) {
    const prefix = `"${word}"*`
    // Only a word that matches nothing is respelled; FTS5's own stemmer decides that.
    const corrections = (await matchesAnything(db, prefix)) ? [] : correctionsOf(word, terms)
    const options = [prefix, ...corrections.map((term) => `"${term}"`)]
    groups.push(options.length > 1 ? `(${options.join(' OR ')})` : prefix)
  }
  const found = new Map<number, PassageHit & { session: string }>()
  const add = (rows: z.output<typeof PassageRow>[], weight: number): void => {
    for (const row of rows) {
      if (found.has(row.id)) continue
      found.set(row.id, {
        session: row.session,
        field: row.field,
        marked: row.marked,
        segmentId: row.segment_id,
        speaker: row.speaker,
        start: row.start_sec,
        // bm25 is negative, more so for a better match; the field sets the floor. The same
        // score orders the query (passageQuery).
        relevance: (FIELD_WEIGHT[row.field] + Math.max(0, -row.rank)) * weight
      })
    }
  }
  const read = async (stmt: InStatement): Promise<z.output<typeof PassageRow>[]> =>
    (await db.execute(stmt)).rows.map((row) => PassageRow.parse(row))
  add(await read(passageQuery('passages_fts', groups.join(' AND '), query)), 1)
  const partial = words.filter((word) => word.length >= 3)
  if (partial.length === words.length) {
    add(await read(passageQuery('passages_tri', partial.map((word) => `"${word}"`).join(' AND '), query)), PARTIAL_WEIGHT)
  }
  return found
}

// --- Sessions -----------------------------------------------------------------------

const SummaryRow = z.object({
  id: z.string(),
  title: z.string(),
  updated_at: z.string(),
  preview: z.string(),
  started_at: z.string(),
  seconds: z.number().nullable(),
  speakers: z.number(),
  tags: z.string().nullable()
})

/** List-view summaries for these sessions, as `listSessions` would give them. */
async function summariesOf(db: Client, ids: string[]): Promise<Map<string, z.output<typeof SummaryRow>>> {
  if (!ids.length) return new Map()
  const result = await db.execute({
    sql: `SELECT s.id, s.title, s.updated_at, s.preview, s.started_at, s.seconds,
        (SELECT count(DISTINCT cluster) FROM segments g WHERE g.session_id = s.id AND g.cluster IS NOT NULL) AS speakers,
        (SELECT json_group_array(tag) FROM (SELECT tag FROM tags t WHERE t.session_id = s.id ORDER BY n)) AS tags
      FROM sessions s WHERE s.id IN (SELECT value FROM json_each(?))`,
    args: [JSON.stringify(ids)]
  })
  return new Map(result.rows.map((row) => {
    const summary = SummaryRow.parse(row)
    return [summary.id, summary]
  }))
}

function hitOf(summary: z.output<typeof SummaryRow>, relevance: number, passages: PassageHit[]): SessionHit {
  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updated_at,
    preview: summary.preview,
    tags: z.array(z.string()).parse(JSON.parse(summary.tags ?? '[]')),
    speakers: summary.speakers,
    startedAt: summary.started_at,
    seconds: summary.seconds,
    relevance,
    passages
  }
}

/** Sessions that only match filters, newest first. */
async function filteredSessions(db: Client, query: SearchQuery, limit: number): Promise<SessionHit[]> {
  const filters = filtersOf(query)
  const result = await db.execute({
    sql: `SELECT s.id FROM sessions s WHERE ${filters.sql} ORDER BY s.started_at DESC LIMIT ${String(limit)}`,
    args: filters.args
  })
  const ids = result.rows.map((row) => z.object({ id: z.string() }).parse(row).id)
  const summaries = await summariesOf(db, ids)
  return ids.flatMap((id) => {
    const summary = summaries.get(id)
    return summary ? [hitOf(summary, 0, [])] : []
  })
}

// --- Meaning ------------------------------------------------------------------------

/**
 * How close a chunk must be to the query to count, and to the best chunk. Measured with
 * nomic-embed-text-v1.5 on paraphrased questions: the note that answers scores 0.54–0.67,
 * unrelated notes 0.40–0.53, so only what's near the top is kept (docs/SEARCH-INDEX.md).
 */
const MIN_SIMILARITY = 0.5
const SIMILARITY_MARGIN = 0.05
const CHUNK_LIMIT = 50
/** Reciprocal rank fusion's damping: a session's score is Σ 1 / (RRF_K + its rank in a list). */
const RRF_K = 60

const ChunkRow = z.object({
  session: z.string(),
  field: z.enum(['summary', 'notes', 'transcript']),
  segment_id: z.string().nullable(),
  start_sec: z.number().nullable(),
  text: z.string(),
  similarity: z.number()
})

/** The chunks closest in meaning to the query, among the filtered sessions; exact, no index. */
async function matchChunks(db: Client, query: SearchQuery, embedder: Embedder): Promise<z.output<typeof ChunkRow>[]> {
  const vector = await embedder.embed(query.text, 'query')
  const filters = filtersOf(query)
  const result = await db.execute({
    sql: `SELECT c.session_id AS session, c.field, c.segment_id, c.start_sec, c.text,
        1 - vector_distance_cos(v.embedding, ?) AS similarity
      FROM chunks c
      JOIN vectors v ON v.hash = c.hash AND v.space = ?
      JOIN sessions s ON s.id = c.session_id
      WHERE ${filters.sql}
      ORDER BY similarity DESC LIMIT ${String(CHUNK_LIMIT)}`,
    args: [new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), embedder.space, ...filters.args]
  })
  const chunks = result.rows.map((row) => ChunkRow.parse(row))
  const best = chunks[0]?.similarity ?? 0
  const floor = Math.max(MIN_SIMILARITY, best - SIMILARITY_MARGIN)
  return chunks.filter((chunk) => chunk.similarity >= floor)
}

// --- Ranking ------------------------------------------------------------------------

type Group = { relevance: number; passages: PassageHit[] }

function keywordGroups(passages: Map<number, PassageHit & { session: string }>): Map<string, Group> {
  const bySession = new Map<string, Group>()
  for (const { session, ...passage } of passages.values()) {
    const group = bySession.get(session) ?? { relevance: 0, passages: [] }
    group.relevance = Math.max(group.relevance, passage.relevance)
    group.passages.push(passage)
    bySession.set(session, group)
  }
  return bySession
}

/**
 * Keyword and meaning results as one list, by reciprocal rank fusion. A session found only by
 * meaning shows its closest chunk, unmarked (no words of the query need be in it).
 */
function fuse(keyword: Map<string, Group>, chunks: z.output<typeof ChunkRow>[]): Map<string, Group> {
  const ranked = [...keyword].sort((a, b) => b[1].relevance - a[1].relevance)
  const fused = new Map<string, Group>()
  ranked.forEach(([id, group], rank) => {
    fused.set(id, { relevance: 1 / (RRF_K + rank + 1), passages: group.passages })
  })
  const bestChunk = new Map<string, z.output<typeof ChunkRow>>()
  for (const chunk of chunks) if (!bestChunk.has(chunk.session)) bestChunk.set(chunk.session, chunk)
  ;[...bestChunk.values()].forEach((chunk, rank) => {
    const group = fused.get(chunk.session) ?? { relevance: 0, passages: [] }
    group.relevance += 1 / (RRF_K + rank + 1)
    if (!group.passages.some((passage) => passage.field !== 'title')) {
      group.passages.push({
        field: chunk.field,
        marked: chunk.text,
        segmentId: chunk.segment_id,
        // A window holds several speakers; its lines name them.
        speaker: null,
        start: chunk.start_sec,
        relevance: chunk.similarity
      })
    }
    fused.set(chunk.session, group)
  })
  return fused
}

export async function search(
  db: Client,
  query: SearchQuery,
  limit: number,
  embedder: Embedder | null
): Promise<SessionHit[]> {
  const words = wordsOf(query.text)
  if (!words.length) return filteredSessions(db, query, limit)
  const keyword = keywordGroups(await matchPassages(db, query, words))
  const chunks = embedder ? await matchChunks(db, query, embedder) : []
  const groups = chunks.length ? fuse(keyword, chunks) : keyword
  const ranked = [...groups].sort((a, b) => b[1].relevance - a[1].relevance).slice(0, limit)
  const summaries = await summariesOf(db, ranked.map(([id]) => id))
  return ranked.flatMap(([id, group]) => {
    const summary = summaries.get(id)
    if (!summary) return []
    // The title row already shows the title, so a title match adds no line of its own.
    const shown = group.passages
      .filter((passage) => passage.field !== 'title')
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_PASSAGES)
    return [hitOf(summary, group.relevance, shown)]
  })
}

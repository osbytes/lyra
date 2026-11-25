import type { Client, InStatement } from '@libsql/client'
import { z } from 'zod'
import {
  IndexStats,
  type PersonRecord,
  type SessionRecord
} from './protocol'
import { PRESERVED_TABLES, SCHEMA, SCHEMA_VERSION, VECTOR_SCHEMA, VECTOR_STORE_VERSION } from './schema'

/**
 * The index worker's queries. Children are written with `json_each` (one statement per table
 * instead of one per row) and read back into the same record shape, so a check can compare
 * the index with the files it came from.
 */

/** Tables holding a session's rows, children first. */
const SESSION_TABLES = [
  'segment_edits',
  'speaker_matches',
  'segments',
  'speakers',
  'tags',
  'tracks',
  'passes',
  'action_items',
  'passages',
  'chunks',
  'embed_queue'
] as const

const flag = z.number().transform((value) => value !== 0)
const text = z.string()
const textOrNull = z.string().nullable()
const num = z.number()
const numOrNull = z.number().nullable()

async function rows<T extends z.ZodType>(db: Client, schema: T, stmt: InStatement): Promise<z.output<T>[]> {
  const result = await db.execute(stmt)
  return result.rows.map((row) => schema.parse(row))
}

/** Drops every table, trigger and index except those of `keep`. */
async function dropTables(db: Client, keep: readonly string[]): Promise<void> {
  const Named = z.object({ name: text, tbl_name: text, sql: textOrNull })
  const list = async (type: 'trigger' | 'table'): Promise<z.output<typeof Named>[]> =>
    (await rows(db, Named, {
      sql: `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`,
      args: [type]
    })).filter((entry) => !keep.includes(entry.tbl_name))
  for (const trigger of await list('trigger')) await db.execute(`DROP TRIGGER IF EXISTS "${trigger.name}"`)
  // Virtual tables first: dropping one drops its shadow tables with it.
  const virtual = (await list('table')).filter((table) => table.sql?.startsWith('CREATE VIRTUAL') === true)
  for (const table of virtual) await db.execute(`DROP TABLE IF EXISTS "${table.name}"`)
  for (const table of await list('table')) await db.execute(`DROP TABLE IF EXISTS "${table.name}"`)
}

async function metaValue(db: Client, table: 'meta' | 'vector_meta', key: string): Promise<string | null> {
  const exists = await rows(db, z.object({ n: num }), {
    sql: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [table]
  })
  if (!exists[0]?.n) return null
  const [row] = await rows(db, z.object({ value: text }), { sql: `SELECT value FROM ${table} WHERE key = ?`, args: [key] })
  return row?.value ?? null
}

/**
 * The vector store, kept through rebuilds; recreated empty only when its own version changes
 * (or it isn't there: a new install, or an index from before it existed).
 */
async function prepareVectors(db: Client): Promise<void> {
  if ((await metaValue(db, 'vector_meta', 'version')) === String(VECTOR_STORE_VERSION)) return
  for (const table of PRESERVED_TABLES) await db.execute(`DROP TABLE IF EXISTS "${table}"`)
  await db.batch(
    [
      ...VECTOR_SCHEMA,
      { sql: 'INSERT INTO vector_meta (key, value) VALUES (?, ?)', args: ['version', String(VECTOR_STORE_VERSION)] }
    ],
    'write'
  )
}

/**
 * Prepares the database for `notesDir`. Returns true when it was (re)created empty: a new
 * install, another schema version, or another notes folder. Stored vectors survive all three
 * (prepareVectors): they're keyed by text and embedding space, not by folder or schema.
 */
export async function prepare(db: Client, notesDir: string): Promise<boolean> {
  await db.execute('PRAGMA journal_mode = WAL')
  await db.execute('PRAGMA foreign_keys = ON')
  await db.execute('PRAGMA busy_timeout = 5000')
  const version = await metaValue(db, 'meta', 'schema_version')
  const folder = await metaValue(db, 'meta', 'notes_dir')
  await prepareVectors(db)
  if (version === String(SCHEMA_VERSION) && folder === notesDir) return false
  await dropTables(db, PRESERVED_TABLES)
  await db.batch(
    [
      ...SCHEMA,
      { sql: 'INSERT INTO meta (key, value) VALUES (?, ?)', args: ['schema_version', String(SCHEMA_VERSION)] },
      { sql: 'INSERT INTO meta (key, value) VALUES (?, ?)', args: ['notes_dir', notesDir] }
    ],
    'write'
  )
  return true
}

/** Corruption shows up here rather than in the middle of a write: a cheap structural check. */
export async function quickCheck(db: Client): Promise<string | null> {
  const result = await rows(db, z.object({ quick_check: text }), 'PRAGMA quick_check')
  const problems = result.map((row) => row.quick_check).filter((line) => line !== 'ok')
  return problems.length ? problems.slice(0, 3).join('; ') : null
}

function deleteSession(id: string): InStatement[] {
  return [
    ...SESSION_TABLES.map((table) => ({ sql: `DELETE FROM ${table} WHERE session_id = ?`, args: [id] })),
    { sql: 'DELETE FROM sessions WHERE id = ?', args: [id] }
  ]
}

export async function removeSession(db: Client, id: string): Promise<void> {
  await db.batch(deleteSession(id), 'write')
}

/**
 * Chunks of a session that lack a vector in `space`, onto the embedding queue. A session's
 * priority is when it was last updated, so the one being worked on is embedded first.
 */
function queueSession(id: string, space: string): InStatement {
  return {
    sql: `INSERT OR IGNORE INTO embed_queue (session_id, hash, priority)
      SELECT c.session_id, c.hash, s.updated_at FROM chunks c JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = ?
        AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash = c.hash AND v.space = ?)`,
    args: [id, space]
  }
}

/**
 * Replaces everything the index holds about one session, in one transaction. With an embedder
 * (`space`), chunks that need a vector are queued; without one, the queue is refilled when an
 * embedder is set (refillEmbedQueue).
 */
export async function upsertSession(db: Client, s: SessionRecord, space: string | null = null): Promise<void> {
  const id = s.id
  const json = JSON.stringify
  await db.batch(
    [
      ...deleteSession(id),
      {
        sql: `INSERT INTO sessions (id, title, title_auto, preview, started_at, ended_at, updated_at,
          seconds, audio, words, export_hash, index_key, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          s.title,
          s.titleAuto ? 1 : 0,
          s.preview,
          s.startedAt,
          s.endedAt,
          s.updatedAt,
          s.seconds,
          s.audio,
          s.words,
          s.exportHash,
          s.indexKey,
          new Date().toISOString()
        ]
      },
      {
        sql: 'INSERT INTO tags (session_id, n, tag) SELECT ?, key, value FROM json_each(?)',
        args: [id, json(s.tags)]
      },
      {
        sql: `INSERT INTO tracks (session_id, n, name, sample_rate, seconds)
          SELECT ?, key, value->>'name', value->>'sampleRate', value->>'seconds' FROM json_each(?)`,
        args: [id, json(s.tracks)]
      },
      {
        sql: `INSERT INTO passes (session_id, n, id, kind, model, created_at)
          SELECT ?, key, value->>'id', value->>'kind', value->>'model', value->>'createdAt' FROM json_each(?)`,
        args: [id, json(s.passes)]
      },
      {
        sql: `INSERT INTO speakers (session_id, n, cluster, name, person_id, confirmed, confidence, talk_sec, segments)
          SELECT ?, key, value->>'cluster', value->>'name', value->>'personId', value->>'confirmed',
            value->>'confidence', value->>'talkSeconds', value->>'segments' FROM json_each(?)`,
        args: [id, json(s.speakers)]
      },
      {
        sql: `INSERT INTO speaker_matches (session_id, cluster, n, person_id, score)
          SELECT ?1, s.value->>'cluster', m.key, m.value->>'personId', m.value->>'score'
          FROM json_each(?2) s, json_each(s.value, '$.matches') m`,
        args: [id, json(s.speakers)]
      },
      {
        sql: `INSERT INTO segments (session_id, n, id, raw_id, start_sec, end_sec, cluster, confidence, edited, text, original)
          SELECT ?, key, value->>'id', value->>'rawId', value->>'start', value->>'end', value->>'cluster',
            value->>'confidence', value->>'edited', value->>'text', value->>'original' FROM json_each(?)`,
        args: [id, json(s.segments)]
      },
      {
        sql: `INSERT INTO segment_edits (session_id, segment_id, n, kind, from_char, to_char, text)
          SELECT ?1, s.value->>'id', e.key, e.value->>'kind', e.value->>'start', e.value->>'end', e.value->>'text'
          FROM json_each(?2) s, json_each(s.value, '$.edits') e`,
        args: [id, json(s.segments)]
      },
      {
        sql: `INSERT INTO action_items (session_id, n, owner, task, done)
          SELECT ?, key, value->>'owner', value->>'task', value->>'done' FROM json_each(?)`,
        args: [id, json(s.actionItems)]
      },
      {
        sql: `INSERT INTO passages (session_id, field, segment_id, cluster, start_sec, text)
          SELECT ?, value->>'field', value->>'segmentId', value->>'cluster', value->>'start', value->>'text'
          FROM json_each(?) ORDER BY key`,
        args: [id, json(s.passages)]
      },
      {
        sql: `INSERT INTO chunks (session_id, field, segment_id, cluster, start_sec, end_sec, text, input, hash)
          SELECT ?, value->>'field', value->>'segmentId', value->>'cluster', value->>'start', value->>'end',
            value->>'text', value->>'input', value->>'hash'
          FROM json_each(?) ORDER BY key`,
        args: [id, json(s.chunks)]
      },
      ...(space === null ? [] : [queueSession(id, space)])
    ],
    'write'
  )
}

/** Rebuilds the embedding queue for `space`: every chunk without a vector in it. */
export async function refillEmbedQueue(db: Client, space: string): Promise<void> {
  await db.batch(
    [
      'DELETE FROM embed_queue',
      {
        sql: `INSERT OR IGNORE INTO embed_queue (session_id, hash, priority)
          SELECT c.session_id, c.hash, s.updated_at FROM chunks c JOIN sessions s ON s.id = c.session_id
          WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash = c.hash AND v.space = ?)`,
        args: [space]
      }
    ],
    'write'
  )
}

/**
 * The next chunks to embed, from the most recently updated sessions: an index walk over the
 * queue, however many chunks the index holds. A hash queued by two sessions comes once.
 */
export async function chunksToEmbed(db: Client, limit: number): Promise<{ hash: string; input: string | null }[]> {
  const queued = await rows(
    db,
    z.object({ hash: text, input: textOrNull }),
    {
      sql: `SELECT q.hash, (SELECT c.input FROM chunks c WHERE c.hash = q.hash LIMIT 1) AS input
        FROM embed_queue q ORDER BY q.priority DESC LIMIT ?`,
      args: [limit]
    }
  )
  const byHash = new Map<string, { hash: string; input: string | null }>()
  for (const chunk of queued) if (!byHash.has(chunk.hash)) byHash.set(chunk.hash, chunk)
  return [...byHash.values()]
}

/** Saves vectors in `space` and takes their hashes off the queue. */
export async function saveEmbeddings(
  db: Client,
  space: string,
  vectors: { hash: string; vector: Float32Array }[]
): Promise<void> {
  await db.batch(
    vectors.flatMap(({ hash, vector }) => [
      {
        sql: 'INSERT OR REPLACE INTO vectors (hash, space, embedding) VALUES (?, ?, ?)',
        // A copy, so the blob is exactly this vector and not the buffer it may share.
        args: [hash, space, vector.slice().buffer]
      },
      { sql: 'DELETE FROM embed_queue WHERE hash = ?', args: [hash] }
    ]),
    'write'
  )
}

/** Takes hashes off the queue without a vector (their chunk is gone). */
export async function dequeue(db: Client, hashes: string[]): Promise<void> {
  await db.execute({ sql: 'DELETE FROM embed_queue WHERE hash IN (SELECT value FROM json_each(?))', args: [JSON.stringify(hashes)] })
}

/**
 * Drops vectors no chunk uses any more (text edited away, sessions deleted) and, when a space is
 * in use, other spaces' vectors. With semantic search off, vectors are kept for when it's back
 * on. Only run after a complete reconcile: mid-rebuild, the chunks that reuse a vector may not
 * be back yet.
 */
export async function pruneEmbeddings(db: Client, space: string | null): Promise<number> {
  const orphans = 'hash NOT IN (SELECT hash FROM chunks)'
  const result = await db.execute(
    space === null
      ? `DELETE FROM vectors WHERE ${orphans}`
      : { sql: `DELETE FROM vectors WHERE space != ? OR ${orphans}`, args: [space] }
  )
  return result.rowsAffected
}

export async function indexKeys(db: Client): Promise<Record<string, string>> {
  const list = await rows(db, z.object({ id: text, index_key: text }), 'SELECT id, index_key FROM sessions')
  return Object.fromEntries(list.map((row) => [row.id, row.index_key]))
}

const SessionRow = z.object({
  title: text,
  title_auto: flag,
  preview: text,
  started_at: text,
  ended_at: textOrNull,
  updated_at: text,
  seconds: numOrNull,
  audio: z.enum(['none', 'kept', 'deleted']),
  words: num,
  export_hash: textOrNull,
  index_key: text
})

/** One session read back from its rows, in the shape it was written; null if not indexed. */
export async function readSession(db: Client, id: string): Promise<SessionRecord | null> {
  const [row] = await rows(db, SessionRow, { sql: 'SELECT * FROM sessions WHERE id = ?', args: [id] })
  if (!row) return null
  const of = (sql: string): InStatement => ({ sql, args: [id] })
  const tags = await rows(db, z.object({ tag: text }), of('SELECT tag FROM tags WHERE session_id = ? ORDER BY n'))
  const tracks = await rows(
    db,
    z.object({ name: z.enum(['mic', 'system']), sample_rate: num, seconds: num }),
    of('SELECT name, sample_rate, seconds FROM tracks WHERE session_id = ? ORDER BY n')
  )
  const passes = await rows(
    db,
    z.object({ id: text, kind: z.enum(['live', 'diarized']), model: text, created_at: text }),
    of('SELECT id, kind, model, created_at FROM passes WHERE session_id = ? ORDER BY n')
  )
  const speakers = await rows(
    db,
    z.object({
      cluster: text,
      name: text,
      person_id: textOrNull,
      confirmed: flag,
      confidence: numOrNull,
      talk_sec: num,
      segments: num
    }),
    of('SELECT * FROM speakers WHERE session_id = ? ORDER BY n')
  )
  const matches = await rows(
    db,
    z.object({ cluster: text, person_id: text, score: num }),
    of('SELECT cluster, person_id, score FROM speaker_matches WHERE session_id = ? ORDER BY cluster, n')
  )
  const segments = await rows(
    db,
    z.object({
      id: text,
      raw_id: textOrNull,
      start_sec: num,
      end_sec: num,
      cluster: textOrNull,
      confidence: numOrNull,
      edited: flag,
      text,
      original: text
    }),
    of('SELECT * FROM segments WHERE session_id = ? ORDER BY n')
  )
  const edits = await rows(
    db,
    z.object({
      segment_id: text,
      kind: z.enum(['replace', 'delete', 'highlight']),
      from_char: num,
      to_char: num,
      text: textOrNull
    }),
    of('SELECT segment_id, kind, from_char, to_char, text FROM segment_edits WHERE session_id = ? ORDER BY segment_id, n')
  )
  const actionItems = await rows(
    db,
    z.object({ owner: textOrNull, task: text, done: flag }),
    of('SELECT owner, task, done FROM action_items WHERE session_id = ? ORDER BY n')
  )
  const passages = await rows(
    db,
    z.object({
      field: z.enum(['title', 'tags', 'summary', 'notes', 'transcript']),
      segment_id: textOrNull,
      cluster: textOrNull,
      start_sec: numOrNull,
      text
    }),
    of('SELECT field, segment_id, cluster, start_sec, text FROM passages WHERE session_id = ? ORDER BY id')
  )
  const chunks = await rows(
    db,
    z.object({
      field: z.enum(['summary', 'notes', 'transcript']),
      segment_id: textOrNull,
      cluster: textOrNull,
      start_sec: numOrNull,
      end_sec: numOrNull,
      text,
      input: text,
      hash: text
    }),
    of('SELECT field, segment_id, cluster, start_sec, end_sec, text, input, hash FROM chunks WHERE session_id = ? ORDER BY id')
  )
  return {
    id,
    title: row.title,
    titleAuto: row.title_auto,
    preview: row.preview,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    seconds: row.seconds,
    audio: row.audio,
    words: row.words,
    exportHash: row.export_hash,
    indexKey: row.index_key,
    tags: tags.map((tag) => tag.tag),
    tracks: tracks.map((track) => ({ name: track.name, sampleRate: track.sample_rate, seconds: track.seconds })),
    passes: passes.map((pass) => ({ id: pass.id, kind: pass.kind, model: pass.model, createdAt: pass.created_at })),
    speakers: speakers.map((speaker) => ({
      cluster: speaker.cluster,
      name: speaker.name,
      personId: speaker.person_id,
      confirmed: speaker.confirmed,
      confidence: speaker.confidence,
      talkSeconds: speaker.talk_sec,
      segments: speaker.segments,
      matches: matches
        .filter((match) => match.cluster === speaker.cluster)
        .map((match) => ({ personId: match.person_id, score: match.score }))
    })),
    segments: segments.map((segment) => ({
      id: segment.id,
      rawId: segment.raw_id,
      start: segment.start_sec,
      end: segment.end_sec,
      cluster: segment.cluster,
      confidence: segment.confidence,
      edited: segment.edited,
      text: segment.text,
      original: segment.original,
      edits: edits
        .filter((edit) => edit.segment_id === segment.id)
        .map((edit) => ({ kind: edit.kind, start: edit.from_char, end: edit.to_char, text: edit.text }))
    })),
    actionItems,
    passages: passages.map((passage) => ({
      field: passage.field,
      segmentId: passage.segment_id,
      cluster: passage.cluster,
      start: passage.start_sec,
      text: passage.text
    })),
    chunks: chunks.map((row) => ({
      field: row.field,
      segmentId: row.segment_id,
      cluster: row.cluster,
      start: row.start_sec,
      end: row.end_sec,
      text: row.text,
      input: row.input,
      hash: row.hash
    }))
  }
}

/** Replaces every person and voiceprint; voices.json is small and rewritten whole anyway. */
export async function replacePeople(db: Client, people: PersonRecord[]): Promise<void> {
  const json = JSON.stringify(people)
  await db.batch(
    [
      'DELETE FROM voiceprints',
      'DELETE FROM people',
      {
        sql: `INSERT INTO people (id, n, name, self, created_at)
          SELECT value->>'id', key, value->>'name', value->>'self', value->>'createdAt' FROM json_each(?)`,
        args: [json]
      },
      // vector32() turns each JSON array into float32s.
      {
        sql: `INSERT INTO voiceprints (person_id, n, dims, embedding)
          SELECT p.value->>'id', v.key, json_array_length(v.value), vector32(v.value)
          FROM json_each(?) p, json_each(p.value, '$.voiceprints') v`,
        args: [json]
      }
    ],
    'write'
  )
}

/** People as the index holds them; voiceprints come back as float32 values. */
export async function readPeople(db: Client): Promise<PersonRecord[]> {
  const people = await rows(
    db,
    z.object({ id: text, name: text, self: flag, created_at: text }),
    'SELECT id, name, self, created_at FROM people ORDER BY n'
  )
  const prints = await rows(
    db,
    z.object({ person_id: text, embedding: z.instanceof(ArrayBuffer) }),
    'SELECT person_id, embedding FROM voiceprints ORDER BY person_id, n'
  )
  return people.map((person) => ({
    id: person.id,
    name: person.name,
    self: person.self,
    createdAt: person.created_at,
    voiceprints: prints
      .filter((print) => print.person_id === person.id)
      .map((print) => [...new Float32Array(print.embedding)])
  }))
}

export async function stats(db: Client, space: string | null): Promise<Omit<IndexStats, 'embedError'>> {
  const count = async (stmt: InStatement): Promise<number> => {
    const [row] = await rows(db, z.object({ n: num }), stmt)
    return row?.n ?? 0
  }
  return IndexStats.omit({ embedError: true }).parse({
    sessions: await count('SELECT count(*) AS n FROM sessions'),
    segments: await count('SELECT count(*) AS n FROM segments'),
    speakers: await count('SELECT count(*) AS n FROM speakers'),
    passages: await count('SELECT count(*) AS n FROM passages'),
    people: await count('SELECT count(*) AS n FROM people'),
    chunks: await count('SELECT count(*) AS n FROM chunks'),
    embedded: await count({
      sql: 'SELECT count(*) AS n FROM chunks c WHERE EXISTS (SELECT 1 FROM vectors v WHERE v.hash = c.hash AND v.space = ?)',
      args: [space]
    })
  })
}

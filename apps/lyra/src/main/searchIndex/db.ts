import type { Client, InStatement } from '@libsql/client'
import { z } from 'zod'
import {
  IndexStats,
  type PersonRecord,
  type SessionRecord
} from './protocol'
import { SCHEMA, SCHEMA_VERSION } from './schema'

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
  'passages'
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

async function dropEverything(db: Client): Promise<void> {
  const Named = z.object({ name: text, sql: textOrNull })
  const triggers = await rows(db, Named, `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`)
  for (const trigger of triggers) await db.execute(`DROP TRIGGER IF EXISTS "${trigger.name}"`)
  // Virtual tables first: dropping one drops its shadow tables with it.
  const tables = await rows(db, Named, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
  const virtual = tables.filter((table) => table.sql?.startsWith('CREATE VIRTUAL') === true)
  for (const table of virtual) await db.execute(`DROP TABLE IF EXISTS "${table.name}"`)
  const left = await rows(db, Named, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
  for (const table of left) await db.execute(`DROP TABLE IF EXISTS "${table.name}"`)
}

async function metaValue(db: Client, key: string): Promise<string | null> {
  const exists = await rows(db, z.object({ n: num }), `SELECT count(*) AS n FROM sqlite_master WHERE name = 'meta'`)
  if (!exists[0]?.n) return null
  const [row] = await rows(db, z.object({ value: text }), { sql: 'SELECT value FROM meta WHERE key = ?', args: [key] })
  return row?.value ?? null
}

/**
 * Prepares the database for `notesDir`. Returns true when it was (re)created empty: a new
 * install, another schema version, or another notes folder.
 */
export async function prepare(db: Client, notesDir: string): Promise<boolean> {
  await db.execute('PRAGMA journal_mode = WAL')
  await db.execute('PRAGMA foreign_keys = ON')
  await db.execute('PRAGMA busy_timeout = 5000')
  const version = await metaValue(db, 'schema_version')
  const folder = await metaValue(db, 'notes_dir')
  if (version === String(SCHEMA_VERSION) && folder === notesDir) return false
  await dropEverything(db)
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

function deleteSession(id: string): InStatement[] {
  return [
    ...SESSION_TABLES.map((table) => ({ sql: `DELETE FROM ${table} WHERE session_id = ?`, args: [id] })),
    { sql: 'DELETE FROM sessions WHERE id = ?', args: [id] }
  ]
}

export async function removeSession(db: Client, id: string): Promise<void> {
  await db.batch(deleteSession(id), 'write')
}

/** Replaces everything the index holds about one session, in one transaction. */
export async function upsertSession(db: Client, s: SessionRecord): Promise<void> {
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
      }
    ],
    'write'
  )
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

export async function stats(db: Client): Promise<IndexStats> {
  const count = async (table: string): Promise<number> => {
    const [row] = await rows(db, z.object({ n: num }), `SELECT count(*) AS n FROM ${table}`)
    return row?.n ?? 0
  }
  return IndexStats.parse({
    sessions: await count('sessions'),
    segments: await count('segments'),
    speakers: await count('speakers'),
    passages: await count('passages'),
    people: await count('people')
  })
}

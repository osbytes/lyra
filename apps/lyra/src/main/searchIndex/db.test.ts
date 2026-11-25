import { createClient, type Client } from '@libsql/client'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { createHashEmbedder, embeddingSpace } from './embedder'
import { openIndex } from './openIndex'
import type { SessionRecord } from './protocol'
import { invalidateVocabulary, search } from './query'
import { chunksOf } from './record'

// These run the real libSQL build under plain Node against a file database in a temp folder.

let dir = ''
let clients: Client[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyra-index-'))
  clients = []
  invalidateVocabulary()
})

afterEach(() => {
  for (const client of clients) client.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Windows keeps a closed database file locked for a while; the temp folder is left behind.
  }
})

async function opened(notesDir = '/notes'): Promise<Awaited<ReturnType<typeof openIndex>>> {
  const result = await openIndex(join(dir, 'lyra.db'), notesDir)
  clients.push(result.client)
  return result
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

type Passage = Omit<SessionRecord['passages'][number], 'segmentId' | 'cluster' | 'start'>

function session(id: string, options: { updatedAt?: string; passages?: Passage[]; chunks?: string[] } = {}): SessionRecord {
  const updatedAt = options.updatedAt ?? '2026-01-01T00:00:00.000Z'
  return {
    id,
    title: id,
    titleAuto: false,
    preview: '',
    startedAt: updatedAt,
    endedAt: null,
    updatedAt,
    seconds: null,
    audio: 'none',
    words: 0,
    exportHash: null,
    indexKey: updatedAt,
    tags: [],
    tracks: [],
    passes: [],
    speakers: [],
    segments: [],
    actionItems: [],
    passages: (options.passages ?? []).map((passage) => ({ ...passage, segmentId: null, cluster: null, start: null })),
    chunks: (options.chunks ?? []).map((text) => ({
      field: 'notes' as const,
      segmentId: null,
      cluster: null,
      start: null,
      end: null,
      text,
      input: text,
      hash: sha(text)
    }))
  }
}

const query = (text: string): Parameters<typeof search>[1] => ({ text, people: [], tags: [], after: null, before: null })

describe('openIndex', () => {
  it('moves a file that is not a database aside and starts over', async () => {
    writeFileSync(join(dir, 'lyra.db'), 'not a database '.repeat(500))
    const { client, fresh, recovered } = await opened()
    expect(fresh).toBe(true)
    expect(recovered).toBe(true)
    await db.upsertSession(client, session('a.md'))
    expect(await db.indexKeys(client)).toEqual({ 'a.md': '2026-01-01T00:00:00.000Z' })
    const aside = readdirSync(dir).filter((file) => file.includes('.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toContain('not a database')
  })

  // On Windows a database this process has had open can't be renamed, even once closed: there
  // the damaged file is marked and moved aside by the next process to open the index.
  const sameProcess = it.skipIf(process.platform === 'win32')

  sameProcess('moves a marked database aside before opening it', async () => {
    const path = join(dir, 'lyra.db')
    const seed = createClient({ url: pathToFileURL(path).href })
    await seed.execute('CREATE TABLE leftover (x)')
    seed.close()
    // What a process that couldn't move its own damaged file leaves behind.
    writeFileSync(`${path}.rebuild`, '')
    const again = await opened()
    expect(again).toMatchObject({ fresh: true, recovered: true })
    expect(readdirSync(dir).filter((file) => file.startsWith('lyra.db.corrupt-'))).toHaveLength(1)
    expect(readdirSync(dir)).not.toContain('lyra.db.rebuild')
    const tables = await again.client.execute(`SELECT name FROM sqlite_master WHERE name = 'leftover'`)
    expect(tables.rows).toHaveLength(0)
  })

  sameProcess('rebuilds a database that opens but fails quick_check', async () => {
    const path = join(dir, 'lyra.db')
    const first = await opened()
    const filler = 'x'.repeat(2000)
    for (let i = 0; i < 40; i++) {
      await db.upsertSession(first.client, session(`s${String(i)}.md`, { passages: [{ field: 'notes', text: filler }] }))
    }
    first.client.close()
    // Checkpoint the WAL into the file, then overwrite pages in its middle.
    const checkpoint = createClient({ url: pathToFileURL(path).href })
    await checkpoint.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    const bytes = readFileSync(path)
    bytes.fill(0xa5, 8192, Math.min(bytes.length - 4096, 8192 * 6))
    writeFileSync(path, bytes)
    const second = await opened()
    expect(second.recovered).toBe(true)
    expect(await db.indexKeys(second.client)).toEqual({})
    expect(await db.quickCheck(second.client)).toBeNull()
  })

  sameProcess('opens a healthy database as it is, and keeps only the newest damaged copy', async () => {
    writeFileSync(join(dir, 'lyra.db'), 'garbage '.repeat(600))
    ;(await opened()).client.close()
    clients = []
    writeFileSync(join(dir, 'lyra.db'), 'garbage again '.repeat(600))
    for (const suffix of ['-wal', '-shm']) rmSync(join(dir, `lyra.db${suffix}`), { force: true })
    const again = await opened()
    expect(again.recovered).toBe(true)
    expect(readdirSync(dir).filter((file) => file.startsWith('lyra.db.corrupt-'))).toHaveLength(1)
    await db.upsertSession(again.client, session('a.md'))
    again.client.close()
    clients = []
    const healthy = await opened()
    expect(healthy).toMatchObject({ fresh: false, recovered: false })
    expect(Object.keys(await db.indexKeys(healthy.client))).toEqual(['a.md'])
  })
})

describe('vectors across rebuilds', () => {
  const space = embeddingSpace('model-sha')
  const vector = new Float32Array(768).fill(1 / Math.sqrt(768))

  it('keeps vectors through a notes-folder change and reuses them', async () => {
    const { client } = await opened('/notes')
    await db.upsertSession(client, session('a.md', { chunks: ['alpha', 'beta'] }), space)
    expect((await db.chunksToEmbed(client, 10)).map((chunk) => chunk.input).sort()).toEqual(['alpha', 'beta'])
    await db.saveEmbeddings(client, space, [{ hash: sha('alpha'), vector }, { hash: sha('beta'), vector }])
    expect(await db.chunksToEmbed(client, 10)).toEqual([])
    client.close()
    clients = []

    const moved = await opened('/moved-notes')
    expect(moved.fresh).toBe(true)
    expect(await db.indexKeys(moved.client)).toEqual({})
    await db.upsertSession(moved.client, session('a.md', { chunks: ['alpha', 'beta', 'gamma'] }), space)
    expect((await db.chunksToEmbed(moved.client, 10)).map((chunk) => chunk.input)).toEqual(['gamma'])
    expect((await db.stats(moved.client, space)).embedded).toBe(2)
  })

  it('upgrades a version-3 index: drops the old table, rebuilds the rest', async () => {
    const path = join(dir, 'lyra.db')
    const old = createClient({ url: pathToFileURL(path).href })
    await old.batch(
      [
        'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        `INSERT INTO meta VALUES ('schema_version', '3'), ('notes_dir', '/notes')`,
        'CREATE TABLE embeddings (hash TEXT NOT NULL, model TEXT NOT NULL, embedding F32_BLOB(768) NOT NULL)',
        `CREATE VIRTUAL TABLE passages_tri USING fts5(text, tokenize='trigram')`
      ],
      'write'
    )
    old.close()
    const { client, fresh } = await opened('/notes')
    expect(fresh).toBe(true)
    const tables = await client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('embeddings', 'vectors')`)
    expect(tables.rows.map((row) => row.name)).toEqual(['vectors'])
  })

  it('queues the most recently updated session first, and refills for a new space', async () => {
    const { client } = await opened()
    await db.upsertSession(client, session('old.md', { updatedAt: '2025-01-01T00:00:00.000Z', chunks: ['old text'] }), space)
    await db.upsertSession(client, session('new.md', { updatedAt: '2026-06-01T00:00:00.000Z', chunks: ['new text'] }), space)
    await db.upsertSession(client, session('mid.md', { updatedAt: '2025-06-01T00:00:00.000Z', chunks: ['mid text'] }), space)
    expect((await db.chunksToEmbed(client, 3)).map((chunk) => chunk.input)).toEqual(['new text', 'mid text', 'old text'])
    await db.saveEmbeddings(client, space, [{ hash: sha('new text'), vector }])
    await db.refillEmbedQueue(client, embeddingSpace('another-model'))
    expect(await db.chunksToEmbed(client, 10)).toHaveLength(3)
    await db.removeSession(client, 'new.md')
    expect((await db.chunksToEmbed(client, 10)).map((chunk) => chunk.input)).toEqual(['mid text', 'old text'])
  })

  it('prunes vectors nothing uses, and other spaces only when a space is given', async () => {
    const { client } = await opened()
    await db.upsertSession(client, session('a.md', { chunks: ['kept'] }), space)
    await db.saveEmbeddings(client, space, [{ hash: sha('kept'), vector }, { hash: sha('edited away'), vector }])
    await db.saveEmbeddings(client, 'other', [{ hash: sha('kept'), vector }])
    expect(await db.pruneEmbeddings(client, null)).toBe(1)
    expect(await db.pruneEmbeddings(client, space)).toBe(1)
    expect((await db.stats(client, space)).embedded).toBe(1)
  })
})

describe('chunksOf', () => {
  const paragraph = (word: string): string => `${word} `.repeat(120).trim()
  const snapshot = (title: string): Parameters<typeof chunksOf>[0] => ({
    title,
    summary: '',
    notes: [paragraph('one'), paragraph('two'), paragraph('three')].join('\n\n'),
    tags: [],
    speakers: [],
    transcript: []
  })

  it('leads only the first chunk with the title, so a rename re-embeds one chunk', () => {
    const before = chunksOf(snapshot('Weekly sync'))
    const after = chunksOf(snapshot('Budget review'))
    expect(before.length).toBeGreaterThan(1)
    expect(before[0]?.input.startsWith('Weekly sync\n')).toBe(true)
    expect(before.slice(1).every((chunk) => chunk.input === chunk.text)).toBe(true)
    const changed = before.filter((chunk, index) => chunk.hash !== after[index]?.hash)
    expect(changed).toHaveLength(1)
  })
})

describe('search', () => {
  it('finds part of a word with accents, typed with or without them', async () => {
    const { client } = await opened()
    await db.upsertSession(client, session('a.md', { passages: [{ field: 'notes', text: 'Call with Mariajosé about the lease' }] }))
    await db.upsertSession(client, session('b.md', { passages: [{ field: 'notes', text: 'Nothing here' }] }))
    for (const text of ['ajose', 'ajosé', 'AJOSE']) {
      const hits = await search(client, query(text), 10, null)
      expect(hits.map((hit) => hit.id)).toEqual(['a.md'])
    }
  })

  it('keeps a title match when a common word fills the passage limit', async () => {
    const { client } = await opened()
    const lines = Array.from({ length: 2100 }, (): Passage => ({ field: 'transcript', text: 'budget' }))
    await db.upsertSession(client, session('busy.md', { passages: lines }))
    await db.upsertSession(client, session('titled.md', {
      passages: [{ field: 'title', text: 'The budget plan for the coming quarter of the year' }]
    }))
    const hits = await search(client, query('budget'), 10, null)
    expect(hits.map((hit) => hit.id)).toContain('titled.md')
    expect(hits[0]?.id).toBe('titled.md')
  })

  it('finds by meaning only through vectors in the embedder\'s space', async () => {
    const { client } = await opened()
    const embedder = createHashEmbedder()
    await db.upsertSession(client, session('car.md', { chunks: ['tires and an oil change for the car'] }), embedder.space)
    for (const chunk of await db.chunksToEmbed(client, 10)) {
      if (chunk.input === null) continue
      await db.saveEmbeddings(client, embedder.space, [{ hash: chunk.hash, vector: await embedder.embed(chunk.input, 'document') }])
    }
    const found = await search(client, query('oil change tires car soon'), 10, embedder)
    expect(found.map((hit) => hit.id)).toEqual(['car.md'])
    const otherSpace = { ...embedder, space: embeddingSpace('other') }
    expect(await search(client, query('xyzzy oil'), 10, otherSpace)).toEqual([])
  })
})

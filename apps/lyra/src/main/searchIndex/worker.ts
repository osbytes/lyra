/**
 * Index worker (utilityProcess): owns the search database and the embedding model, so neither
 * blocks the main process. Requests run one at a time, in order; embedding new text runs between
 * them, a few chunks at a time. See docs/SEARCH-INDEX.md.
 */
import type { Client } from '@libsql/client'
import { z } from 'zod'
import * as db from './db'
import { createHashEmbedder, createLlamaEmbedder, embeddingSpace, type Embedder } from './embedder'
import { openIndex } from './openIndex'
import { invalidateVocabulary, search } from './query'
import { IndexEnvelope, type IndexRequest, type IndexResponse } from './protocol'

/** Chunks embedded per step: a search that arrives meanwhile waits for one (about 0.2 s on CPU). */
const EMBED_BATCH = 1
/** A breather between steps, so a long backlog doesn't hold a CPU core flat out. */
const EMBED_GAP_MS = 25

let client: Client | null = null
let embedder: Embedder | null = null
/** Why embedding last stopped, until it works again. */
let embedError: string | null = null
/** Background embedding held off (main: recording, on battery). */
let paused = false

function open(): Client {
  if (!client) throw new Error('The search index is not open')
  return client
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs `task` after everything already queued. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  return run
}

/** Embeds the next few chunks waiting for a vector; returns how many it took off the queue. */
async function embedStep(): Promise<number> {
  const current = embedder
  if (!client || !current) return 0
  const todo = await db.chunksToEmbed(client, EMBED_BATCH)
  const vectors: { hash: string; vector: Float32Array }[] = []
  const gone: string[] = []
  for (const chunk of todo) {
    if (chunk.input === null) gone.push(chunk.hash)
    else vectors.push({ hash: chunk.hash, vector: await current.embed(chunk.input, 'document') })
  }
  if (gone.length) await db.dequeue(client, gone)
  if (vectors.length) await db.saveEmbeddings(client, current.space, vectors)
  return todo.length
}

let pumpTimer: ReturnType<typeof setTimeout> | null = null

/** Keeps embedding in the background until the queue is empty, unless paused. */
function schedulePump(delay = EMBED_GAP_MS): void {
  if (pumpTimer || !embedder || paused) return
  pumpTimer = setTimeout(() => {
    pumpTimer = null
    if (paused) return
    void enqueue(embedStep).then(
      (done) => {
        embedError = null
        if (done > 0) schedulePump()
      },
      (error: unknown) => {
        // Stops until the next change; a broken model shouldn't spin.
        embedError = error instanceof Error ? error.message : String(error)
      }
    )
  }, delay)
}

function setPaused(next: boolean): void {
  paused = next
  if (paused && pumpTimer) {
    clearTimeout(pumpTimer)
    pumpTimer = null
  }
  if (!paused) schedulePump(0)
}

/**
 * A model is never disposed here: disposing node-llama-cpp's last model ends this process. Main
 * restarts the worker to unload it (searchIndex/service.ts, applySemanticSearch).
 */
async function setEmbedder(choice: Extract<IndexRequest, { type: 'setEmbedder' }>['embedder']): Promise<void> {
  embedError = null
  // Already loaded: loading it again would hold two copies, since neither can be disposed.
  // Asked again (Settings' Retry after embedding failed): pick the backlog back up.
  if (choice?.kind === 'llama' && embedder?.space === embeddingSpace(choice.sha256)) {
    schedulePump(0)
    return
  }
  embedder = null
  if (!choice) return
  const next = choice.kind === 'hash' ? createHashEmbedder() : await createLlamaEmbedder(choice.modelPath, choice.sha256)
  if (client) await db.refillEmbedQueue(client, next.space)
  embedder = next
  schedulePump(0)
}

async function handle(request: IndexRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      client?.close()
      client = null
      invalidateVocabulary()
      const opened = await openIndex(request.path, request.notesDir)
      client = opened.client
      if (embedder) await db.refillEmbedQueue(client, embedder.space)
      schedulePump()
      return { fresh: opened.fresh, recovered: opened.recovered }
    }
    case 'search':
      return search(open(), request.query, request.limit, embedder)
    case 'upsertSession':
      await db.upsertSession(open(), request.session, embedder?.space ?? null)
      invalidateVocabulary()
      schedulePump()
      return null
    case 'removeSession':
      await db.removeSession(open(), request.id)
      invalidateVocabulary()
      return null
    case 'setEmbedder':
      await setEmbedder(request.embedder)
      return null
    case 'drainEmbeddings':
      while ((await embedStep()) > 0) {
        // Every chunk gets its vector before this returns.
      }
      return null
    case 'setPaused':
      setPaused(request.paused)
      return null
    case 'pruneEmbeddings':
      return db.pruneEmbeddings(open(), embedder?.space ?? null)
    case 'replacePeople':
      await db.replacePeople(open(), request.people)
      return null
    case 'indexKeys':
      return db.indexKeys(open())
    case 'readSession':
      return db.readSession(open(), request.id)
    case 'readPeople':
      return db.readPeople(open())
    case 'stats':
      return { ...(await db.stats(open(), embedder?.space ?? null)), embedError }
    case 'close':
      if (pumpTimer) clearTimeout(pumpTimer)
      pumpTimer = null
      await setEmbedder(null)
      client?.close()
      client = null
      return null
  }
}

function reply(response: IndexResponse): void {
  process.parentPort.postMessage(response)
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const parsed = IndexEnvelope.safeParse(event.data)
  if (!parsed.success) {
    // Answer what can be answered, so the caller doesn't wait forever.
    const envelope = z.object({ id: z.number().int() }).safeParse(event.data)
    if (envelope.success) reply({ id: envelope.data.id, ok: false, error: 'Malformed index request' })
    return
  }
  const { id, request } = parsed.data
  enqueue(() => handle(request)).then(
    (result) => {
      reply({ id, ok: true, result })
    },
    (error: unknown) => {
      reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  )
})

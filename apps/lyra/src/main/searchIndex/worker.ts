/**
 * Index worker (utilityProcess): owns the search database and the embedding model, so neither
 * blocks the main process. Requests run one at a time, in order; embedding new text runs between
 * them, a few chunks at a time. See docs/SEARCH-INDEX.md.
 */
import { createClient, type Client } from '@libsql/client'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import * as db from './db'
import { createHashEmbedder, createLlamaEmbedder, type Embedder } from './embedder'
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

/** Embeds the next few chunks that lack a vector; returns how many it did. */
async function embedStep(): Promise<number> {
  const current = embedder
  if (!client || !current) return 0
  const todo = await db.chunksToEmbed(client, current.model, EMBED_BATCH)
  const vectors: { hash: string; vector: Float32Array }[] = []
  for (const chunk of todo) vectors.push({ hash: chunk.hash, vector: await current.embed(chunk.input, 'document') })
  if (vectors.length) await db.saveEmbeddings(client, current.model, vectors)
  return todo.length
}

let pumpTimer: ReturnType<typeof setTimeout> | null = null

/** Keeps embedding in the background until every chunk has a vector. */
function schedulePump(delay = EMBED_GAP_MS): void {
  if (pumpTimer || !embedder) return
  pumpTimer = setTimeout(() => {
    pumpTimer = null
    void enqueue(embedStep).then(
      async (done) => {
        embedError = null
        if (done === EMBED_BATCH) schedulePump()
        else if (client) await enqueue(() => db.pruneEmbeddings(open(), embedder?.model ?? null))
      },
      (error: unknown) => {
        // Stops until the next change; a broken model shouldn't spin.
        embedError = error instanceof Error ? error.message : String(error)
      }
    )
  }, delay)
}

async function setEmbedder(choice: Extract<IndexRequest, { type: 'setEmbedder' }>['embedder']): Promise<void> {
  await embedder?.dispose()
  embedder = null
  embedError = null
  if (!choice) return
  embedder = choice.kind === 'hash' ? createHashEmbedder() : await createLlamaEmbedder(choice.modelPath, choice.model)
  schedulePump(0)
}

async function handle(request: IndexRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      client?.close()
      mkdirSync(dirname(request.path), { recursive: true })
      // A real file URL: a plain `file:` + path breaks on a '#' or '%' in it (a user name).
      client = createClient({ url: pathToFileURL(request.path).href })
      invalidateVocabulary()
      const fresh = await db.prepare(client, request.notesDir)
      schedulePump()
      return { fresh }
    }
    case 'search':
      return search(open(), request.query, request.limit, embedder)
    case 'upsertSession':
      await db.upsertSession(open(), request.session)
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
      return { ...(await db.stats(open(), embedder?.model ?? null)), embedError }
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

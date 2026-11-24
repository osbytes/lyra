/**
 * Index worker (utilityProcess): owns the search database, so its queries never block the main
 * process. Requests run one at a time, in order. See docs/SEARCH-INDEX.md.
 */
import { createClient, type Client } from '@libsql/client'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import * as db from './db'
import { IndexEnvelope, type IndexRequest, type IndexResponse } from './protocol'

let client: Client | null = null

function open(): Client {
  if (!client) throw new Error('The search index is not open')
  return client
}

async function handle(request: IndexRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      client?.close()
      mkdirSync(dirname(request.path), { recursive: true })
      // `file:` plus the plain path: libsql reads the rest of the URL as the path as-is.
      client = createClient({ url: `file:${request.path}` })
      return { fresh: await db.prepare(client, request.notesDir) }
    }
    case 'upsertSession':
      await db.upsertSession(open(), request.session)
      return null
    case 'removeSession':
      await db.removeSession(open(), request.id)
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
      return db.stats(open())
    case 'close':
      client?.close()
      client = null
      return null
  }
}

let queue: Promise<unknown> = Promise.resolve()

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
  const run = queue.then(() => handle(request))
  queue = run.catch(() => undefined)
  run.then(
    (result) => {
      reply({ id, ok: true, result })
    },
    (error: unknown) => {
      reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  )
})

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { log } from '../log'
import { notesDir } from '../pages'
import {
  listSessions,
  onSessionChange,
  peekManifest,
  readSessionFromDisk,
  type SessionChange
} from '../sessionStore'
import { onSettingsChanged } from '../settings'
import { listVoicePeople, onPeopleSaved, type VoicePerson } from '../voices'
import {
  IndexResponse,
  IndexStats,
  OpenResult,
  PersonRecord,
  SessionRecord,
  type IndexEnvelope,
  type IndexRequest
} from './protocol'
import { sessionRecordOf } from './record'

/**
 * The search index from the main process: forks the index worker, mirrors every session and
 * person into it as they're saved, and reconciles it with the notes folder at startup. The
 * database is derived data (docs/SEARCH-INDEX.md); when it fails, Lyra works without it.
 */

/** Live transcription saves often; a session is reindexed once it has been quiet this long. */
const INDEX_DELAY_MS = 1500

let worker: UtilityProcess | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function databasePath(): string {
  return join(app.getPath('userData'), 'index', 'lyra.db')
}

function fork(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'indexWorker.js'), [], { serviceName: 'Lyra search index' })
  child.on('message', (message: unknown) => {
    const parsed = IndexResponse.safeParse(message)
    if (!parsed.success) return
    const response = parsed.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(response.error))
  })
  child.on('exit', (code) => {
    log('search-index', 'worker exited', { code })
    if (worker === child) {
      worker = null
      ready = null
    }
    for (const entry of pending.values()) entry.reject(new Error('Search index worker stopped'))
    pending.clear()
  })
  return child
}

function send(child: UtilityProcess, request: IndexRequest): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const envelope: IndexEnvelope = { id, request }
    child.postMessage(envelope)
  })
}

/** Starts the worker if needed and opens the database for the current notes folder. */
function ensureReady(): Promise<void> {
  if (ready) return ready
  const child = fork()
  worker = child
  ready = send(child, { type: 'open', path: databasePath(), notesDir: notesDir() }).then((result) => {
    if (OpenResult.parse(result).fresh) log('search-index', 'created an empty index')
  })
  return ready
}

async function call<S extends z.ZodType>(request: IndexRequest, schema: S): Promise<z.output<S>> {
  await ensureReady()
  if (!worker) throw new Error('Search index worker stopped')
  return schema.parse(await send(worker, request))
}

// --- Keeping it current ------------------------------------------------------------

/** What's waiting to be written for each session, newest wins. */
const queued = new Map<string, { record: SessionRecord } | { remove: true }>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Restored sessions still being read from disk before they're queued. */
const reading = new Set<Promise<void>>()
/** People are written in the order voices.json was saved. */
let peopleWriting: Promise<void> = Promise.resolve()

async function write(id: string): Promise<void> {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  const next = queued.get(id)
  queued.delete(id)
  if (!next) return
  try {
    if ('record' in next) await call({ type: 'upsertSession', session: next.record }, z.null())
    else await call({ type: 'removeSession', id }, z.null())
  } catch (error) {
    log('search-index', 'could not update a session', { id, error: String(error) })
  }
}

function schedule(id: string, next: { record: SessionRecord } | { remove: true }, delay: number): void {
  queued.set(id, next)
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.set(
    id,
    setTimeout(() => {
      void write(id)
    }, delay)
  )
}

/** A session's record straight from its files, as the export last left them. */
async function recordFromDisk(id: string): Promise<SessionRecord | null> {
  const manifest = peekManifest(id)
  if (!manifest) return null
  return sessionRecordOf(id, manifest, await readSessionFromDisk(id))
}

function onChange(change: SessionChange): void {
  switch (change.kind) {
    case 'saved':
      schedule(change.id, { record: sessionRecordOf(change.id, change.manifest, change.snapshot) }, INDEX_DELAY_MS)
      return
    case 'removed':
      schedule(change.id, { remove: true }, 0)
      return
    case 'restored': {
      const read = recordFromDisk(change.id).then(
        (record) => {
          if (record) schedule(change.id, { record }, 0)
        },
        (error: unknown) => {
          log('search-index', 'could not read a restored session', { id: change.id, error: String(error) })
        }
      )
      reading.add(read)
      void read.finally(() => reading.delete(read))
      return
    }
  }
}

const personRecord = (person: VoicePerson): PersonRecord => ({
  id: person.id,
  name: person.name,
  self: person.self,
  createdAt: person.createdAt,
  voiceprints: person.voiceprints
})

async function writePeople(people: VoicePerson[]): Promise<void> {
  try {
    await call({ type: 'replacePeople', people: people.map(personRecord) }, z.null())
  } catch (error) {
    log('search-index', 'could not update people', { error: String(error) })
  }
}

/**
 * Brings the index in line with the notes folder: indexes sessions it lacks or holds an older
 * version of, and drops sessions that are gone. Runs in the background at startup.
 */
async function reconcile(): Promise<void> {
  const started = Date.now()
  const keys = z.record(z.string(), z.string()).parse(await call({ type: 'indexKeys' }, z.unknown()))
  const sessions = await listSessions()
  const live = new Set(sessions.map((session) => session.id))
  let indexed = 0
  let removed = 0
  for (const id of Object.keys(keys)) {
    if (live.has(id) || queued.has(id)) continue
    await call({ type: 'removeSession', id }, z.null())
    removed++
  }
  for (const session of sessions) {
    if (keys[session.id] === session.updatedAt || queued.has(session.id)) continue
    try {
      const record = await recordFromDisk(session.id)
      if (!record) continue
      await call({ type: 'upsertSession', session: record }, z.null())
      indexed++
    } catch (error) {
      log('search-index', 'could not index a session', { id: session.id, error: String(error) })
    }
  }
  await writePeople(await listVoicePeople())
  const counts = await call({ type: 'stats' }, IndexStats)
  log('search-index', 'reconciled', { indexed, removed, ms: Date.now() - started, ...counts })
}

let reconciling: Promise<void> = Promise.resolve()

function startReconcile(): void {
  reconciling = reconciling
    .then(reconcile)
    .catch((error: unknown) => {
      log('search-index', 'reconcile failed', { error: String(error) })
    })
}

/** Opens the index and keeps it in step with sessions, people and the notes folder. */
export function startSearchIndex(): void {
  onSessionChange(onChange)
  onPeopleSaved((people) => {
    peopleWriting = peopleWriting.then(() => writePeople(people))
  })
  onSettingsChanged((next, previous) => {
    if (next.notesDir === previous.notesDir) return
    // Another folder is another index: reopen, which starts it over, then fill it.
    reconciling = reconciling.then(async () => {
      await writeQueued()
      await stopSearchIndex()
    })
    startReconcile()
  })
  startReconcile()
}

/** Writes everything still waiting, then waits for a running reconcile. */
export async function flushSearchIndex(): Promise<void> {
  await writeQueued()
  await reconciling
}

async function writeQueued(): Promise<void> {
  await Promise.all([...reading, peopleWriting])
  await Promise.all([...queued.keys()].map((id) => write(id)))
}

/** On quit: writes what's waiting and closes, without waiting for a reconcile to finish. */
export async function closeSearchIndex(): Promise<void> {
  await writeQueued()
  await stopSearchIndex()
}

/** Closes the database and stops the worker; the next call starts it again. */
export async function stopSearchIndex(): Promise<void> {
  const child = worker
  if (!child) return
  try {
    await call({ type: 'close' }, z.null())
  } catch (error) {
    log('search-index', 'could not close the index', { error: String(error) })
  }
  child.kill()
  if (worker === child) {
    worker = null
    ready = null
  }
}

/** Every session in the notes folder and every person, compared with what the index holds. */
export async function checkSearchIndex(): Promise<{ sessions: number; mismatched: string[] }> {
  await flushSearchIndex()
  const mismatched: string[] = []
  const sessions = await listSessions()
  for (const session of sessions) {
    const expected = await recordFromDisk(session.id)
    const actual = await call({ type: 'readSession', id: session.id }, SessionRecord.nullable())
    if (!expected || !actual || !isDeepStrictEqual(expected, actual)) mismatched.push(session.id)
  }
  const keys = z.record(z.string(), z.string()).parse(await call({ type: 'indexKeys' }, z.unknown()))
  const live = new Set(sessions.map((session) => session.id))
  for (const id of Object.keys(keys)) if (!live.has(id)) mismatched.push(`${id} (gone)`)
  // Voiceprints are stored as float32s, so they're compared at that precision.
  const people = (await listVoicePeople()).map((person) => ({
    ...personRecord(person),
    voiceprints: person.voiceprints.map((print) => print.map(Math.fround))
  }))
  const stored = await call({ type: 'readPeople' }, z.array(PersonRecord))
  if (!isDeepStrictEqual(people, stored)) mismatched.push('people')
  return { sessions: sessions.length, mismatched }
}

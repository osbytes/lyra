import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { PeopleActivity } from '../../shared/peopleActivity'
import type { SearchQuery } from '../../shared/searchQuery'
import { PACKAGED_FLAG } from '../meeting/notesFormat'
import { log } from '../log'
import { cancelModelDownload, ensureModelFile, type ModelFile } from '../models'
import { downloadReporter, onModelRetry, reportModelFailure, setModelStatus } from '../modelStatus'
import { notesDir } from '../pages'
import {
  listSessions,
  onSessionChange,
  peekManifest,
  readSessionFromDisk,
  type SessionChange
} from '../sessionStore'
import { getSettings, onSettingsChanged } from '../settings'
import { listVoicePeople, onPeopleSaved, type VoicePerson } from '../voices'
import {
  IndexResponse,
  IndexStats,
  OpenResult,
  PersonRecord,
  SessionHit,
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
/** A failed session write is tried this many times in all, further apart each time. */
const MAX_WRITE_ATTEMPTS = 3
const WRITE_RETRY_MS = 2000
/**
 * A worker that crashes or can't open waits before the next start, doubling each time: each
 * start reopens the database and, with semantic search on, reloads a 146 MB model.
 */
const RESTART_BASE_MS = 2000
const RESTART_MAX_MS = 5 * 60_000
/** After this many failed starts in a row the index stays off until the app restarts. */
const MAX_FAILED_STARTS = 6
/** A worker that has run this long without trouble resets the count. */
const STABLE_MS = 60_000
/** How often Settings' "Reading your sessions" count is brought up to date. */
const READING_POLL_MS = 1500

/** The worker is gone or waiting to restart: retrying the same request now can't help. */
class IndexUnavailable extends Error {}

let worker: UtilityProcess | null = null
let ready: Promise<void> | null = null
let nextId = 1
/**
 * Requests waiting for an answer, by the worker they went to: a worker that exits fails only
 * its own, even when its exit arrives after the next worker has started.
 */
const pending = new Map<number, { child: UtilityProcess; resolve: (value: unknown) => void; reject: (error: Error) => void }>()
/** Workers we stopped on purpose; any other exit is a crash. */
const stopping = new WeakSet<UtilityProcess>()
/** Workers already counted as a failed start (an open can fail and then the worker exits). */
const failed = new WeakSet<UtilityProcess>()
let failedStarts = 0
let startedAt = 0
let restartAt = 0
let restartTimer: ReturnType<typeof setTimeout> | null = null

function databasePath(): string {
  return join(app.getPath('userData'), 'index', 'lyra.db')
}

/**
 * nomic-embed-text-v1.5 (Apache-2.0), 8-bit: 768-dimension text embeddings, about 146 MB,
 * downloaded the first time semantic search is turned on.
 */
const EMBEDDING_MODEL: ModelFile = {
  name: 'nomic-embed-text-v1.5.Q8_0.gguf',
  url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.Q8_0.gguf',
  bytes: 146_146_432,
  sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7'
}

type EmbedderChoice = Extract<IndexRequest, { type: 'setEmbedder' }>['embedder']

/** What the worker should embed with; sent again whenever the worker restarts. */
let embedderChoice: EmbedderChoice = null

/** Why background embedding is held off; sent again whenever the worker restarts. */
const busy = new Set<IndexBusyReason>()

/**
 * Counts a failed start or a crash, once per worker, and sets when the next start may happen.
 * After a crash the startup reconcile runs again then, since writes in flight were lost.
 */
function noteFailure(child: UtilityProcess, what: string, error: string): void {
  if (failed.has(child)) return
  failed.add(child)
  if (startedAt && Date.now() - startedAt > STABLE_MS) failedStarts = 0
  startedAt = 0
  failedStarts++
  if (failedStarts >= MAX_FAILED_STARTS) {
    log('search-index', 'giving up on the index until the next launch', { what, failedStarts, error })
    return
  }
  const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (failedStarts - 1))
  restartAt = Date.now() + delay
  log('search-index', `${what}; restarting later`, { failedStarts, ms: delay, error })
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    startReconcile()
  }, delay)
}

function fork(): UtilityProcess {
  // The worker can't ask `app` whether this is a packaged build, so it's told on its command line.
  const child = utilityProcess.fork(join(__dirname, 'indexWorker.js'), app.isPackaged ? [PACKAGED_FLAG] : [], {
    serviceName: 'Lyra search index'
  })
  child.on('message', (message: unknown) => {
    const parsed = IndexResponse.safeParse(message)
    if (!parsed.success) return
    const response = parsed.data
    const entry = pending.get(response.id)
    if (entry?.child !== child) return
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
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue
      pending.delete(id)
      entry.reject(new IndexUnavailable('Search index worker stopped'))
    }
    if (!stopping.has(child)) noteFailure(child, 'the index worker crashed', `exit code ${String(code)}`)
  })
  return child
}

function send(child: UtilityProcess, request: IndexRequest): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { child, resolve, reject })
    const envelope: IndexEnvelope = { id, request }
    child.postMessage(envelope)
  })
}

/**
 * Starts the worker if needed and opens the database for the current notes folder. A failed
 * open doesn't stick: the worker is stopped and a later call (after the backoff) tries again.
 */
function ensureReady(): Promise<void> {
  if (ready) return ready
  if (failedStarts >= MAX_FAILED_STARTS) return Promise.reject(new IndexUnavailable('The search index is off after repeated failures'))
  if (Date.now() < restartAt) return Promise.reject(new IndexUnavailable('The search index is restarting'))
  const child = fork()
  worker = child
  const opening = send(child, { type: 'open', path: databasePath(), notesDir: notesDir() }).then(async (result) => {
    const opened = OpenResult.parse(result)
    if (opened.recovered) log('search-index', 'the index was damaged; rebuilding it (the old file is kept beside it)')
    else if (opened.fresh) log('search-index', 'created an empty index')
    if (busy.size) await send(child, { type: 'setPaused', paused: true })
    if (embedderChoice) await restoreEmbedder(child, embedderChoice)
    startedAt = Date.now()
    // A rebuilt index is empty: fill it now, not at the next launch. (Startup and crash restarts
    // reconcile on their own; this covers a reopen mid-run.)
    if (opened.recovered) startReconcile()
  })
  ready = opening
  opening.catch((error: unknown) => {
    noteFailure(child, 'could not open the index', String(error))
    stopping.add(child)
    child.kill()
    if (worker === child) {
      worker = null
      ready = null
    }
  })
  return opening
}

/** A model that no longer loads turns semantic search off rather than failing the index. */
async function restoreEmbedder(child: UtilityProcess, choice: NonNullable<EmbedderChoice>): Promise<void> {
  try {
    await send(child, { type: 'setEmbedder', embedder: choice })
  } catch (error) {
    if (error instanceof IndexUnavailable) throw error
    if (embedderChoice === choice) embedderChoice = null
    log('search-index', 'semantic search unavailable', { error: String(error) })
    reportModelFailure('semanticSearch', EMBEDDING_MODEL, error)
    return
  }
  // A restarted worker carries on embedding; Settings carries on counting.
  void watchEmbedding()
}

let watching = 0

/**
 * Reports how far background embedding has got, as Settings shows it ("Reading your sessions"),
 * until every passage has a vector, embedding fails, or semantic search is turned off. Only the
 * newest call keeps going.
 */
async function watchEmbedding(): Promise<void> {
  const run = ++watching
  const model = EMBEDDING_MODEL.name
  // Asked afresh after every await: turning semantic search off or a newer watch ends this one.
  const current = (): boolean => run === watching && embedderChoice?.kind === 'llama'
  for (;;) {
    if (!current()) return
    let stats: IndexStats
    try {
      stats = await call({ type: 'stats' }, IndexStats)
    } catch (error) {
      // A worker that is restarting starts a new watch once its embedder is back.
      if (!(error instanceof IndexUnavailable)) reportModelFailure('semanticSearch', EMBEDDING_MODEL, error)
      return
    }
    if (!current()) return
    if (stats.embedError) {
      setModelStatus({ feature: 'semanticSearch', model, state: 'error', message: stats.embedError })
      return
    }
    if (stats.embedded >= stats.chunks) {
      setModelStatus({ feature: 'semanticSearch', model, state: 'ready' })
      return
    }
    const [pausedFor = null] = busy
    setModelStatus({ feature: 'semanticSearch', model, state: 'reading', done: stats.embedded, total: stats.chunks, pausedFor })
    await sleep(READING_POLL_MS)
  }
}

/**
 * Turns semantic search on (downloading the model the first time) or off. Keyword search works
 * either way; a failed download or load leaves it off and is logged.
 */
async function applySemanticSearch(enabled: boolean): Promise<void> {
  try {
    if (!enabled) {
      const loaded = embedderChoice?.kind === 'llama'
      embedderChoice = null
      // A model can't be unloaded inside the worker (worker.ts, setEmbedder): restart it instead,
      // between reconciles; the next call starts a worker without one.
      if (loaded) {
        reconciling = reconciling
          .then(async () => {
            await writeQueued()
            await stopSearchIndex()
          })
          .catch((error: unknown) => {
            log('search-index', 'could not restart the index', { error: String(error) })
          })
        await reconciling
      }
      return
    }
    let logged = 0
    const report = downloadReporter('semanticSearch', EMBEDDING_MODEL)
    const modelPath = await ensureModelFile(EMBEDDING_MODEL, (received, total) => {
      report(received, total)
      const percent = Math.floor((received / total) * 4) * 25
      if (percent > logged) log('search-index', 'downloading the embedding model', { percent })
      logged = Math.max(logged, percent)
    })
    embedderChoice = { kind: 'llama', modelPath, sha256: EMBEDDING_MODEL.sha256 }
    // Loading the model takes a few seconds; the count follows once it reads.
    setModelStatus({ feature: 'semanticSearch', model: EMBEDDING_MODEL.name, state: 'reading', done: 0, total: 0, pausedFor: null })
    await call({ type: 'setEmbedder', embedder: embedderChoice }, z.null())
    log('search-index', 'semantic search on', { model: EMBEDDING_MODEL.name })
    void watchEmbedding()
  } catch (error) {
    embedderChoice = null
    log('search-index', 'semantic search unavailable', { error: String(error) })
    // Turned off meanwhile (which cancels the download): there's nothing to report.
    if (getSettings().semanticSearch) reportModelFailure('semanticSearch', EMBEDDING_MODEL, error)
  }
}

let semanticChange: Promise<void> = Promise.resolve()

function setSemanticSearch(enabled: boolean): void {
  // Turning it off shouldn't wait for 146 MB to finish arriving first.
  if (!enabled) cancelModelDownload(EMBEDDING_MODEL.name)
  semanticChange = semanticChange.then(() => applySemanticSearch(enabled))
}

/** Tests: embed with the word-hashing stand-in instead of the model (or with nothing). */
export async function useTestEmbedder(on: boolean): Promise<void> {
  await semanticChange
  embedderChoice = on ? { kind: 'hash' } : null
  await call({ type: 'setEmbedder', embedder: embedderChoice }, z.null())
}

/** Tests: waits until every chunk has a vector. */
export async function drainEmbeddings(): Promise<IndexStats> {
  await writeQueued()
  await call({ type: 'drainEmbeddings' }, z.null())
  return call({ type: 'stats' }, IndexStats)
}

async function call<S extends z.ZodType>(request: IndexRequest, schema: S): Promise<z.output<S>> {
  await ensureReady()
  if (!worker) throw new IndexUnavailable('Search index worker stopped')
  return schema.parse(await send(worker, request))
}

// --- Keeping it current ------------------------------------------------------------

/**
 * What's waiting to be written for each session, newest wins. A save holds how to build its
 * record rather than the record: chunking and hashing a long transcript is real work on the
 * main thread, so it's done once, when the debounced write fires, not on every save.
 */
type Queued = ({ kind: 'save'; build: () => Promise<SessionRecord | null> } | { kind: 'remove' }) & { attempts: number }

const queued = new Map<string, Queued>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
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
    if (next.kind === 'remove') await call({ type: 'removeSession', id }, z.null())
    else {
      const record = await next.build()
      if (record) await call({ type: 'upsertSession', session: record }, z.null())
    }
  } catch (error) {
    // A newer change replaces this one; otherwise try again, a few times. A write that still
    // fails is caught by the reconcile after a restart, or at the next launch.
    if (queued.has(id)) return
    const attempts = next.attempts + 1
    if (attempts >= MAX_WRITE_ATTEMPTS) {
      log('search-index', 'could not update a session', { id, attempts, error: String(error) })
      return
    }
    schedule(id, { ...next, attempts }, WRITE_RETRY_MS * attempts)
  }
}

function schedule(id: string, next: Queued, delay: number): void {
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
    case 'saved': {
      const { id, manifest, snapshot } = change
      schedule(id, { kind: 'save', build: () => Promise.resolve(sessionRecordOf(id, manifest, snapshot)), attempts: 0 }, INDEX_DELAY_MS)
      return
    }
    case 'removed':
      schedule(change.id, { kind: 'remove', attempts: 0 }, 0)
      return
    case 'restored': {
      const { id } = change
      schedule(id, { kind: 'save', build: () => recordFromDisk(id), attempts: 0 }, 0)
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

/** A failure is only logged: the reconcile after a restart writes people again. */
async function writePeople(people: VoicePerson[]): Promise<void> {
  try {
    await call({ type: 'replacePeople', people: people.map(personRecord) }, z.null())
  } catch (error) {
    log('search-index', 'could not update people', { error: String(error) })
  }
}

/** Lets a reconcile of thousands of sessions share the main thread with recording IPC. */
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Brings the index in line with the notes folder: indexes sessions it lacks or holds an older
 * version of, and drops sessions that are gone. Runs in the background at startup, after a
 * worker crash, and when the notes folder changes. It stops at the first sign the worker is
 * gone (the reconcile after its restart carries on); a session that fails on its own is skipped.
 */
async function reconcile(): Promise<void> {
  const started = Date.now()
  const keys = z.record(z.string(), z.string()).parse(await call({ type: 'indexKeys' }, z.unknown()))
  const sessions = await listSessions()
  const live = new Set(sessions.map((session) => session.id))
  let indexed = 0
  let removed = 0
  let skipped = 0
  const skip = (id: string, error: unknown): void => {
    if (error instanceof IndexUnavailable) throw error
    skipped++
    log('search-index', 'could not index a session', { id, error: String(error) })
  }
  for (const id of Object.keys(keys)) {
    if (live.has(id) || queued.has(id)) continue
    try {
      await call({ type: 'removeSession', id }, z.null())
      removed++
    } catch (error) {
      skip(id, error)
    }
  }
  for (const session of sessions) {
    if (keys[session.id] === session.updatedAt || queued.has(session.id)) continue
    try {
      // Decoding a document and chunking it is synchronous; one session at a time between turns.
      await breathe()
      const record = await recordFromDisk(session.id)
      if (!record) continue
      await call({ type: 'upsertSession', session: record }, z.null())
      indexed++
    } catch (error) {
      skip(session.id, error)
    }
  }
  await writePeople(await listVoicePeople())
  // Only a complete pass knows which vectors nothing uses; a partial one would drop vectors a
  // session still waiting to be indexed (skipped, or queued meanwhile) is about to reuse.
  const pruned = skipped || queued.size ? 0 : await call({ type: 'pruneEmbeddings' }, z.number())
  const counts = await call({ type: 'stats' }, IndexStats)
  log('search-index', 'reconciled', { indexed, removed, skipped, pruned, ms: Date.now() - started, ...counts })
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
    if (next.semanticSearch !== previous.semanticSearch) setSemanticSearch(next.semanticSearch)
    if (next.notesDir === previous.notesDir) return
    // Another folder is another index: reopen, which starts it over, then fill it.
    reconciling = reconciling.then(async () => {
      await writeQueued()
      await stopSearchIndex()
    })
    startReconcile()
  })
  startReconcile()
  onModelRetry('semanticSearch', () => {
    if (getSettings().semanticSearch) setSemanticSearch(true)
  })
  if (getSettings().semanticSearch) setSemanticSearch(true)
}

/** Writes everything still waiting, then waits for a running reconcile. */
export async function flushSearchIndex(): Promise<void> {
  await writeQueued()
  await reconciling
}

async function writeQueued(): Promise<void> {
  await peopleWriting
  await Promise.all([...queued.keys()].map((id) => write(id)))
}

/**
 * Sessions matching `query`, best first. Pending edits are written first, so a note saved a
 * moment ago is found.
 */
export async function searchIndex(query: SearchQuery, limit: number): Promise<SessionHit[]> {
  await writeQueued()
  return call({ type: 'search', query, limit }, z.array(SessionHit))
}

/** Who spoke in which session; pending edits are written first, like a search. */
export async function peopleActivity(): Promise<PeopleActivity> {
  await writeQueued()
  return call({ type: 'peopleActivity' }, PeopleActivity)
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
  stopping.add(child)
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

export type IndexBusyReason = 'recording' | 'battery'

/**
 * Holds background embedding while `reason` lasts: it competes with Whisper for the CPU, and
 * drains a battery. Searches still work (and embed their query); the backlog resumes after.
 */
export function setIndexBusy(reason: IndexBusyReason, on: boolean): void {
  const was = busy.size > 0
  if (on) busy.add(reason)
  else busy.delete(reason)
  const paused = busy.size > 0
  if (paused === was) return
  // No worker yet: the next one is told when it starts (ensureReady). Not worth starting one.
  const child = worker
  const opening = ready
  if (!child || !opening) return
  void opening
    .then(() => send(child, { type: 'setPaused', paused }))
    .catch((error: unknown) => {
      log('search-index', 'could not pause indexing', { error: String(error) })
    })
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

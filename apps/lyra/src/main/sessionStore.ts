import { app, shell, webContents } from 'electron'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import * as Y from 'yjs'
import { asideStamp, writeFileAtomic, writeFileAtomicSync } from './atomicFile'
import { applyLog, frame } from './sessionLog'
import {
  manifestForDisk,
  MANIFEST_VERSION,
  parseManifest,
  type Manifest,
  type ParsedManifest,
  type TrackInfo
} from './sessionManifest'
import { passesOnDisk, tracksOnDisk } from './sessionRecovery'
import type { Page, PageSummary } from '../shared/types'
import {
  asUpdate,
  editDoc,
  initDoc,
  replaceTranscript,
  restoreMissingSpeakers,
  docTitle,
  snapshotOf,
  upsertSpeaker,
  type NewSegment,
  type SessionSnapshot
} from '../shared/sessionDoc'
import { splitNotes, TRANSCRIPT_DIVIDER as TRANSCRIPT_HEADING } from './meeting/notesFormat'
import { log } from './log'
import {
  ensurePagesDir,
  isNoteName,
  markOwnWrite,
  notesDir,
  notifyPagesChanged,
  parsePage,
  resolveInNotes,
  serializePage,
  timestampStem
} from './pages'
import { defaultTitle } from './sessionTitle'
import { getSettings } from './settings'

/**
 * Sessions: one Yjs document per note, persisted as an append-only update log, with the
 * note file and a `.lyra.json` metadata file written from it as an export. See
 * docs/SESSION-MODEL.md.
 *
 *   <notes>/<id>                         export (the .txt/.md the user sees)
 *   <notes>/<stem>.lyra.json             export metadata
 *   <notes>/.sessions/<id>/session.json  manifest
 *   <notes>/.sessions/<id>/doc.yjs       document update log
 */

const SIDECAR_SCHEMA = 'lyra.session/1'
const EXPORT_DELAY_MS = 300
/** Rewrite the log as one merged update once it holds this many. */
const COMPACT_AFTER = 400
/** Keep an idle document in memory this long, so switching back is instant. */
const UNLOAD_AFTER_MS = 30_000
const ORIGIN_LOAD = 'load'
const ORIGIN_MAIN = 'main'
const ORIGIN_AUTO_TITLE = 'auto-title'
const PREVIEW_CHARS = 72
/**
 * The largest update a window may send in one go. Typing and pasting produce kilobytes; this
 * only stops a runaway or hostile renderer from making main allocate without bound.
 */
const MAX_WINDOW_UPDATE_BYTES = 32 * 1024 * 1024

type Entry = {
  id: string
  /**
   * The notes folder this session was loaded from. Its files are always written here, so a
   * pending export never lands in a new folder after Settings switches it.
   */
  root: string
  doc: Y.Doc
  manifest: Manifest
  /** `session.json` as read, so fields from a newer Lyra survive a rewrite. */
  manifestRaw: Record<string, unknown> | undefined
  /** Counts document changes, so an export can tell whether more arrived while it ran. */
  generation: number
  /** Dropped from `open` by `closeAllSessions` while still in use; unload once released. */
  closed: boolean
  frames: number
  refs: number
  /** webContents ids that hold a replica and want updates. */
  subscribers: Set<number>
  exportTimer: ReturnType<typeof setTimeout> | null
  unloadTimer: ReturnType<typeof setTimeout> | null
  exporting: Promise<void>
}

/** Open documents, by notes folder and id (`keyOf`). */
const open = new Map<string, Entry>()

const keyOf = (root: string, id: string): string => `${root}\0${id}`
const openEntry = (id: string): Entry | undefined => open.get(keyOf(notesDir(), id))

// --- Paths ------------------------------------------------------------------

export function sessionsRoot(): string {
  return join(notesDir(), '.sessions')
}

/** A session's folder under `root`; the id is checked to be a plain note name first. */
function sessionDirIn(root: string, id: string): string {
  resolveInNotes(id)
  return join(root, '.sessions', id)
}

function notePathIn(root: string, id: string): string {
  resolveInNotes(id)
  return join(root, id)
}

const sessionDir = (id: string): string => sessionDirIn(notesDir(), id)
const manifestPathIn = (root: string, id: string): string => join(sessionDirIn(root, id), 'session.json')
const docPathIn = (root: string, id: string): string => join(sessionDirIn(root, id), 'doc.yjs')
export const sessionAudioDir = (id: string): string => join(sessionDir(id), 'audio')
export const sessionRawDir = (id: string): string => join(sessionDir(id), 'raw')

/** One model pass over a session's audio, kept as it was produced (docs/SESSION-MODEL.md). */
export type RawPass = {
  id: string
  kind: 'live' | 'diarized'
  model: string
  createdAt: string
  segments: {
    id: string
    start: number
    end: number
    track: 'mic' | 'system' | 'mix'
    cluster: string | null
    confidence: number | null
    words: { text: string; start: number; end: number }[]
  }[]
  clusters: { id: string; embedding: number[]; matches: { personId: string; score: number }[] }[]
}

export type { TrackInfo }

const stemOf = (id: string): string => id.slice(0, -extname(id).length)

/** `<stem>.lyra.json`, unless a note with the same stem and another extension exists. */
function sidecarName(id: string, root: string = notesDir()): string {
  const stem = stemOf(id)
  const twin = ['.txt', '.md'].some(
    (ext) => ext !== extname(id).toLowerCase() && existsSync(join(root, stem + ext))
  )
  return twin ? `${id}.lyra.json` : `${stem}.lyra.json`
}

// --- Manifest ---------------------------------------------------------------

type ManifestRead =
  | Extract<ParsedManifest, { kind: 'ok' }>
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }

/**
 * Parsed manifests by path, with the file's identity when read. A list re-reads only the files
 * that changed (the store's own writes drop their entry; anything else changes the stamp).
 */
const manifestCache = new Map<string, { stamp: string; read: ManifestRead }>()

/** Newer manifests already logged, so a synced folder doesn't fill the log on every list. */
const loggedNewer = new Set<string>()

const stampOf = (info: { ino: number; size: number; mtimeMs: number }): string =>
  `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

/**
 * Reads `session.json`. `missing` and `corrupt` are told apart, so a load never mistakes an
 * unreadable manifest for a note that has no session yet. Other I/O errors throw: the file may
 * be fine, just not readable right now.
 */
function readManifestFile(root: string, id: string): ManifestRead {
  const path = manifestPathIn(root, id)
  let stamp: string
  try {
    stamp = stampOf(statSync(path))
  } catch (error) {
    manifestCache.delete(path)
    if (isMissing(error)) return { kind: 'missing' }
    throw error
  }
  const cached = manifestCache.get(path)
  if (cached?.stamp === stamp) return cached.read
  let read: ManifestRead
  try {
    const parsed = parseManifest(JSON.parse(readFileSync(path, 'utf8')), id, new Date().toISOString())
    read = parsed.kind === 'ok' ? parsed : { kind: 'corrupt', reason: parsed.reason }
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    if (!(error instanceof SyntaxError)) throw error
    read = { kind: 'corrupt', reason: 'not JSON' }
  }
  if (read.kind === 'ok' && read.newer && !loggedNewer.has(id)) {
    loggedNewer.add(id)
    log('sessions', 'manifest is from a newer Lyra; keeping its extra fields', {
      id,
      version: read.raw.version
    })
  }
  if (read.kind === 'ok' && read.idMismatch) log('sessions', 'manifest named another session', { id })
  manifestCache.set(path, { stamp, read })
  return read
}

/** For readers that only look (list, retention, search): null when it can't be read now. */
function readManifest(id: string): Manifest | null {
  try {
    const read = readManifestFile(notesDir(), id)
    return read.kind === 'ok' ? read.manifest : null
  } catch (error) {
    log('sessions', 'could not read manifest', { id, error: String(error) })
    return null
  }
}

type ManifestTarget = Pick<Entry, 'root' | 'manifest' | 'manifestRaw'>

/** Atomic and durable: a temp file, fsynced, renamed over the old one. */
function writeManifest(target: ManifestTarget): void {
  const path = manifestPathIn(target.root, target.manifest.id)
  writeFileAtomicSync(path, JSON.stringify(manifestForDisk(target.manifest, target.manifestRaw), null, 2))
  manifestCache.delete(path)
}

/** Keeps an unreadable file beside where it was, for a person (or a newer Lyra) to recover. */
async function setAside(path: string, how: 'move' | 'copy'): Promise<string> {
  const aside = `${path}.corrupt-${asideStamp()}`
  if (how === 'move') await rename(path, aside)
  else await copyFile(path, aside)
  return aside
}

// --- Update log -------------------------------------------------------------

function compact(entry: Entry): void {
  writeFileAtomicSync(docPathIn(entry.root, entry.id), frame(Y.encodeStateAsUpdate(entry.doc)))
  entry.frames = 1
}

// --- Loading and migration ----------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function previewOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line
}

/** `2026-11-20_14-03-27…` file names carry the session start; anything else uses the mtime. */
function startedAtFromId(id: string, fallback: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(id)
  if (!match) return fallback.toISOString()
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const date = new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0)
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString()
}

const LEGACY_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\] (.+?): (.*)$/
const BYTES_PER_SECOND = 16000 * 2

/** The fields of a manifest that come from the document, for the list view and search. */
function docSummaryFields(snapshot: SessionSnapshot): Pick<Manifest, 'title' | 'preview' | 'tags' | 'speakers'> {
  return {
    title: snapshot.title.trim() || 'Untitled',
    // The words people said, not the export's transcript heading.
    preview: previewOf(
      snapshot.notes.trim() ||
        // The summary's own "Summary" heading isn't something anyone said.
        snapshot.summary.trim().replace(/^Summary\s*\n/, '') ||
        snapshot.transcript.map((line) => line.text).join(' ')
    ),
    tags: snapshot.tags,
    speakers: new Set(snapshot.transcript.flatMap((line) => (line.cluster ? [line.cluster] : []))).size
  }
}

type LegacyMeta = {
  speakers: { cluster: number; name: string; personId: string | null; embedding: number[] }[]
  liveTranscript: string
}

async function readLegacyMeta(root: string, id: string): Promise<LegacyMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, '.meta', `${stemOf(id)}.json`), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const meta = parsed as Record<string, unknown>
    if (meta.version !== 1 || !Array.isArray(meta.speakers)) return null
    const speakers = (meta.speakers as unknown[]).flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const s = value as Record<string, unknown>
      if (typeof s.cluster !== 'number' || typeof s.name !== 'string') return []
      return [{
        cluster: s.cluster,
        name: s.name,
        personId: typeof s.personId === 'string' ? s.personId : null,
        embedding: Array.isArray(s.embedding) ? s.embedding.filter((n): n is number => typeof n === 'number') : []
      }]
    })
    return { speakers, liveTranscript: typeof meta.liveTranscript === 'string' ? meta.liveTranscript : '' }
  } catch {
    return null
  }
}

/**
 * A meeting labeled by Lyra 0.2: `[hh:mm:ss] Name: text` lines in the note, speakers in
 * `.meta/<stem>.json`, audio in `.audio/`. Rebuilds the transcript, speakers and raw passes.
 */
async function migrateLegacyMeeting(root: string, id: string, doc: Y.Doc, body: string, meta: LegacyMeta): Promise<{
  notes: string
  tracks: TrackInfo[]
  passes: Manifest['passes']
}> {
  const { notes: summary, transcript } = splitNotes(body)
  const hasDivider = transcript !== body
  const byName = new Map(meta.speakers.map((speaker) => [speaker.name, `c${String(speaker.cluster)}`]))
  const segments: NewSegment[] = []
  const leftover: string[] = []
  for (const line of (hasDivider ? transcript : body).split(/\r?\n/)) {
    const match = LEGACY_LINE.exec(line)
    if (!match) {
      if (line.trim() && !line.startsWith('People: ')) leftover.push(line)
      continue
    }
    const [, h, m, sec, name = 'Speaker', text = ''] = match
    const start = Number(h) * 3600 + Number(m) * 60 + Number(sec)
    let cluster = byName.get(name)
    if (!cluster) {
      cluster = `c${String(byName.size + meta.speakers.length)}`
      byName.set(name, cluster)
    }
    const previous = segments.at(-1)
    if (previous) previous.end = Math.max(previous.start, start)
    segments.push({ id: `s${String(segments.length)}`, rawId: null, start, end: start, cluster, confidence: null, text })
  }
  const last = segments.at(-1)
  if (last) last.end = last.start + 5

  for (const speaker of meta.speakers) {
    upsertSpeaker(doc, `c${String(speaker.cluster)}`, {
      name: speaker.name,
      personId: speaker.personId,
      // Lyra 0.2 named unknown voices "Speaker N"; any other name was the user's choice.
      confirmed: speaker.personId !== null || !/^Speaker \d+$/.test(speaker.name),
      confidence: null,
      matches: []
    }, ORIGIN_LOAD)
  }
  for (const [name, cluster] of byName) {
    if (!meta.speakers.some((speaker) => `c${String(speaker.cluster)}` === cluster)) {
      upsertSpeaker(doc, cluster, { name, personId: null, confirmed: true, confidence: null, matches: [] }, ORIGIN_LOAD)
    }
  }
  replaceTranscript(doc, segments, ORIGIN_LOAD)
  if (hasDivider) editDoc(doc, { summary }, ORIGIN_LOAD)

  const raw = join(sessionDirIn(root, id), 'raw')
  await mkdir(raw, { recursive: true })
  const now = new Date().toISOString()
  const pass: RawPass = {
    id: 'legacy',
    kind: 'diarized',
    model: 'Lyra 0.2 meeting labels',
    createdAt: now,
    segments: segments.map((segment) => ({
      id: segment.id, start: segment.start, end: segment.end, track: 'mix', cluster: segment.cluster,
      confidence: null, words: [{ text: segment.text, start: segment.start, end: segment.end }]
    })),
    clusters: meta.speakers.map((speaker) => ({ id: `c${String(speaker.cluster)}`, embedding: speaker.embedding, matches: [] }))
  }
  await writeFile(join(raw, 'legacy.json'), JSON.stringify(pass), 'utf8')
  const passes: Manifest['passes'] = [{ id: 'legacy', kind: 'diarized', createdAt: now, model: pass.model }]
  if (meta.liveTranscript) {
    await writeFile(join(raw, 'live.json'), JSON.stringify({ id: 'live', kind: 'live', model: 'whisper (streaming)', createdAt: now, text: meta.liveTranscript, segments: [], clusters: [] }), 'utf8')
    passes.push({ id: 'live', kind: 'live', createdAt: now, model: 'whisper (streaming)' })
  }

  // Move the recording, if it was kept, into the session folder.
  const tracks: TrackInfo[] = []
  const audioDir = join(sessionDirIn(root, id), 'audio')
  for (const name of ['mic', 'system'] as const) {
    const from = join(root, '.audio', `${stemOf(id)}.${name}.wav`)
    if (!existsSync(from)) continue
    await mkdir(audioDir, { recursive: true })
    const to = join(audioDir, `${name}.wav`)
    await copyFile(from, to)
    await unlink(from)
    const size = (await stat(to)).size
    tracks.push({ name, file: `${name}.wav`, sampleRate: 16000, seconds: Math.max(0, size - 44) / BYTES_PER_SECOND })
  }
  await rename(join(root, '.meta', `${stemOf(id)}.json`), join(root, '.meta', `${stemOf(id)}.json.migrated`)).catch(() => undefined)
  log('sessions', 'migrated a labeled meeting', { id, segments: segments.length, tracks: tracks.length })
  return { notes: leftover.join('\n').trim(), tracks, passes }
}

/**
 * A note file with no session yet (older Lyra, or dropped in from outside) becomes one. Only
 * when neither a manifest nor a document log exists (or both were unreadable and set aside):
 * it never writes over a `doc.yjs`. Audio and passes already in the folder are kept.
 */
async function migrateNote(id: string, root: string): Promise<Entry> {
  const path = notePathIn(root, id)
  const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  const page = parsePage(raw, id, info.mtime.toISOString())
  const doc = new Y.Doc()
  initDoc(doc, { title: page.title === 'Untitled' ? '' : page.title, notes: '' }, ORIGIN_LOAD)
  const dir = sessionDirIn(root, id)
  mkdirSync(dir, { recursive: true })
  const legacy = await readLegacyMeta(root, id)
  const meeting = legacy ? await migrateLegacyMeeting(root, id, doc, page.body, legacy) : null
  editDoc(doc, { notes: meeting ? meeting.notes : page.body }, ORIGIN_LOAD)
  const tracks = meeting?.tracks ?? (await tracksOnDisk(join(dir, 'audio')))
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    id,
    startedAt: startedAtFromId(id, info.birthtime),
    endedAt: null,
    updatedAt: page.updatedAt,
    tracks,
    passes: meeting?.passes ?? (await passesOnDisk(join(dir, 'raw'))),
    audio: tracks.length ? 'kept' : 'none',
    title: page.title,
    titleAuto: false,
    preview: previewOf(page.body),
    tags: [],
    speakers: 0,
    // The file is already what the document says; leave it byte-for-byte as it is.
    exportHash: sha256(raw),
    // A migrated meeting's export gains the metadata file; plain notes stay untouched.
    dirty: meeting !== null
  }
  // `wx`: a log that appeared meanwhile (a sync client delivering it) is never overwritten.
  writeFileSync(docPathIn(root, id), frame(Y.encodeStateAsUpdate(doc)), { flag: 'wx' })
  writeManifest({ root, manifest, manifestRaw: undefined })
  emitChange({ kind: 'saved', id, manifest, snapshot: snapshotOf(doc) })
  log('sessions', 'created session from note', { id, tracks: manifest.tracks.length, passes: manifest.passes.length })
  return makeEntry({ id, root, doc, manifest, manifestRaw: undefined, frames: 1 })
}

/**
 * The manifest is fine but the log is gone (a sync client that hasn't fetched it yet) or held
 * nothing usable: the document is rebuilt from the export, keeping the manifest's audio, passes
 * and dates.
 */
async function rebuildDocFromExport(id: string, root: string, read: Extract<ManifestRead, { kind: 'ok' }>): Promise<Entry> {
  const path = notePathIn(root, id)
  const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  const page = parsePage(raw, id, info.mtime.toISOString())
  const doc = new Y.Doc()
  initDoc(doc, { title: page.title === 'Untitled' ? '' : page.title, notes: page.body }, ORIGIN_LOAD)
  const manifest: Manifest = {
    ...read.manifest,
    title: page.title,
    preview: previewOf(page.body),
    speakers: 0,
    exportHash: sha256(raw),
    dirty: false
  }
  writeFileSync(docPathIn(root, id), frame(Y.encodeStateAsUpdate(doc)), { flag: 'wx' })
  const entry = makeEntry({ id, root, doc, manifest, manifestRaw: read.raw, frames: 1 })
  writeManifest(entry)
  emitChange({ kind: 'saved', id, manifest, snapshot: snapshotOf(doc) })
  log('sessions', 'rebuilt a missing document from its export', { id, passes: manifest.passes.length })
  return entry
}

/**
 * The log is fine but the manifest is missing or unreadable: rebuilt from the document and the
 * audio and passes on disk. Marked dirty, so the export is rewritten from the document (an
 * export that differs is kept in `external/` first).
 */
async function rebuildManifest(id: string, root: string, doc: Y.Doc): Promise<Manifest> {
  const dir = sessionDirIn(root, id)
  const info = await stat(notePathIn(root, id)).catch(() => null)
  const snapshot = snapshotOf(doc)
  const tracks = await tracksOnDisk(join(dir, 'audio'))
  return {
    version: MANIFEST_VERSION,
    id,
    startedAt: startedAtFromId(id, info?.birthtime ?? new Date()),
    endedAt: null,
    updatedAt: info?.mtime.toISOString() ?? new Date().toISOString(),
    tracks,
    passes: await passesOnDisk(join(dir, 'raw')),
    audio: tracks.length ? 'kept' : 'none',
    ...docSummaryFields(snapshot),
    titleAuto: !snapshot.title.trim(),
    exportHash: null,
    dirty: true
  }
}

function makeEntry(init: Pick<Entry, 'id' | 'root' | 'doc' | 'manifest' | 'manifestRaw' | 'frames'>): Entry {
  const entry: Entry = {
    ...init,
    generation: 0,
    closed: false,
    refs: 0,
    subscribers: new Set(),
    exportTimer: null,
    unloadTimer: null,
    exporting: Promise.resolve()
  }
  entry.doc.on('update', (update: Uint8Array, origin: unknown) => {
    onDocUpdate(entry, update, origin)
  })
  docTitle(entry.doc).observe((_event, transaction) => {
    onTitleChange(entry, transaction.origin)
  })
  return entry
}

/** The log's bytes, or null when there is no log. */
async function readLog(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * Opens a session from disk, repairing what it can and never destroying what it can't read:
 * an unreadable manifest or log is set aside (`*.corrupt-<time>`) before anything replaces it.
 */
async function load(id: string, root: string): Promise<Entry> {
  const manifestPath = manifestPathIn(root, id)
  const logPath = docPathIn(root, id)
  const read = readManifestFile(root, id)
  const bytes = await readLog(logPath)
  if (read.kind === 'missing' && bytes === null) return migrateNote(id, root)

  let doc: Y.Doc | null = null
  let frames = 0
  let damaged = false
  if (bytes !== null) {
    const loaded = new Y.Doc()
    const result = applyLog(loaded, bytes, ORIGIN_LOAD)
    if (result.applied > 0) {
      doc = loaded
      frames = result.applied
      damaged = result.damaged
    } else {
      // An empty or unreadable log would open as an empty document and then overwrite the
      // export with nothing: rebuild from the export instead.
      loaded.destroy()
      const aside = await setAside(logPath, 'move')
      log('sessions', 'set aside an unusable document log', { id, bytes: bytes.byteLength, aside })
    }
  }

  if (read.kind === 'corrupt') {
    const aside = await setAside(manifestPath, 'move')
    manifestCache.delete(manifestPath)
    log('sessions', 'set aside an unreadable manifest', { id, reason: read.reason, aside })
  }

  if (!doc) {
    return read.kind === 'ok' ? rebuildDocFromExport(id, root, read) : migrateNote(id, root)
  }

  if (damaged) {
    const aside = await setAside(logPath, 'copy')
    log('sessions', 'document log was damaged; kept what was readable', { id, frames, aside })
  }

  let entry: Entry
  if (read.kind === 'ok') {
    entry = makeEntry({ id, root, doc, manifest: read.manifest, manifestRaw: read.raw, frames })
  } else {
    const manifest = await rebuildManifest(id, root, doc)
    entry = makeEntry({ id, root, doc, manifest, manifestRaw: undefined, frames })
    writeManifest(entry)
    log('sessions', 'rebuilt a manifest from the document', {
      id,
      tracks: manifest.tracks.length,
      passes: manifest.passes.length
    })
  }
  // Rewritten at once, so later appends land after a clean frame, not after the garbage.
  if (damaged) compact(entry)
  const restored = restoreMissingSpeakers(doc, ORIGIN_MAIN)
  if (restored) log('sessions', 'restored missing speakers', { id, speakers: restored })
  if (entry.manifest.dirty) scheduleExport(entry, 0)
  return entry
}

const loading = new Map<string, Promise<Entry>>()

/** Sessions whose note file exists but whose folder is still being written. */
const creating = new Map<string, Promise<void>>()

async function acquire(id: string): Promise<Entry> {
  resolveInNotes(id)
  await creating.get(id)
  const root = notesDir()
  const key = keyOf(root, id)
  let entry = open.get(key)
  if (!entry) {
    let pending = loading.get(key)
    if (!pending) {
      pending = load(id, root)
      loading.set(key, pending)
    }
    try {
      const loaded = await pending
      // Someone else opened it meanwhile (e.g. it was just created): theirs wins.
      entry = open.get(key) ?? loaded
    } finally {
      loading.delete(key)
    }
    open.set(key, entry)
  }
  entry.refs++
  if (entry.unloadTimer) clearTimeout(entry.unloadTimer)
  entry.unloadTimer = null
  return entry
}

function release(entry: Entry): void {
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs > 0 || entry.subscribers.size > 0) return
  if (entry.unloadTimer) clearTimeout(entry.unloadTimer)
  entry.unloadTimer = setTimeout(() => void unload(entry), UNLOAD_AFTER_MS)
}

const isCurrent = (entry: Entry): boolean => open.get(keyOf(entry.root, entry.id)) === entry

const inUse = (entry: Entry): boolean => entry.refs > 0 || entry.subscribers.size > 0

async function unload(entry: Entry): Promise<void> {
  if (inUse(entry) || (!isCurrent(entry) && !entry.closed)) return
  await flushExport(entry)
  // Someone acquired it, or it was replaced, while the export ran: leave it to them.
  if (inUse(entry) || (!isCurrent(entry) && !entry.closed)) return
  try {
    if (entry.frames > 1) compact(entry)
  } catch (error) {
    log('sessions', 'compaction failed', { id: entry.id, error: String(error) })
  }
  if (isCurrent(entry)) open.delete(keyOf(entry.root, entry.id))
  entry.doc.destroy()
}

// --- Changes ------------------------------------------------------------------

/**
 * Runs inside Yjs's update event, so it never throws: a throw here would surface in whoever
 * changed the document after the change was already made.
 */
function onDocUpdate(entry: Entry, update: Uint8Array, origin: unknown): void {
  if (origin === ORIGIN_LOAD) return
  entry.generation++
  try {
    appendFileSync(docPathIn(entry.root, entry.id), frame(update))
    entry.frames++
    if (entry.frames >= COMPACT_AFTER) compact(entry)
  } catch (error) {
    log('sessions', 'could not persist update', { id: entry.id, error: String(error) })
  }
  if (!entry.manifest.dirty) {
    entry.manifest = { ...entry.manifest, dirty: true }
    try {
      writeManifest(entry)
    } catch (error) {
      log('sessions', 'could not mark session dirty', { id: entry.id, error: String(error) })
    }
  }
  const from = typeof origin === 'number' ? origin : null
  for (const id of entry.subscribers) {
    if (id === from) continue
    try {
      const target = webContents.fromId(id)
      if (!target || target.isDestroyed()) entry.subscribers.delete(id)
      else target.send('sessions:update', { id: entry.id, update })
    } catch (error) {
      log('sessions', 'could not send update to a window', { id: entry.id, error: String(error) })
    }
  }
  scheduleExport(entry, EXPORT_DELAY_MS)
}

/**
 * A title change from a window (its id is the origin) or `saveSessionPage` is the user's: from
 * then on Lyra leaves the title alone, unless they clear it.
 */
function onTitleChange(entry: Entry, origin: unknown): void {
  if (typeof origin !== 'number' && origin !== ORIGIN_MAIN) return
  const titleAuto = !docTitle(entry.doc).toJSON().trim()
  if (entry.manifest.titleAuto === titleAuto) return
  entry.manifest = { ...entry.manifest, titleAuto }
  try {
    writeManifest(entry)
  } catch (error) {
    log('sessions', 'could not save title flag', { id: entry.id, error: String(error) })
  }
}

function scheduleExport(entry: Entry, delay: number): void {
  if (entry.exportTimer) clearTimeout(entry.exportTimer)
  entry.exportTimer = setTimeout(() => {
    entry.exportTimer = null
    entry.exporting = entry.exporting.then(() => writeExport(entry)).catch((error: unknown) => {
      log('sessions', 'export failed', { id: entry.id, error: String(error) })
    })
  }, delay)
}

async function flushExport(entry: Entry): Promise<void> {
  if (entry.exportTimer) {
    clearTimeout(entry.exportTimer)
    entry.exportTimer = null
    const run = entry.exporting.then(() => writeExport(entry))
    // The chain itself never stays rejected, or every later export would be skipped.
    entry.exporting = run.catch((error: unknown) => {
      log('sessions', 'export failed', { id: entry.id, error: String(error) })
    })
    await run
    return
  }
  await entry.exporting
}

// --- Export ---------------------------------------------------------------------



function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/**
 * Generated notes, the user's notes, then the transcript (once there is one) as
 * `[hh:mm:ss] Name: text` lines under a People line. With no summary or transcript, the
 * export is exactly the notes, so a plain note reads like it always has.
 */
function exportBody(snapshot: SessionSnapshot): string {
  if (!snapshot.transcript.length && !snapshot.summary.trim()) return snapshot.notes
  const names = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.name]))
  const nameOf = (cluster: string | null): string =>
    cluster ? (names.get(cluster) ?? cluster) : 'Speaker'
  const parts = [snapshot.summary.trim(), snapshot.notes.trim()].filter(Boolean)
  if (snapshot.transcript.length) {
    const people = [...new Set(snapshot.transcript.map((segment) => nameOf(segment.cluster)))]
    const lines = snapshot.transcript.map(
      (segment) => `[${clock(segment.start)}] ${nameOf(segment.cluster)}: ${segment.text}`
    )
    parts.push(`${TRANSCRIPT_HEADING}\n\nPeople: ${people.join(', ')}\n\n${lines.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** When retention will delete this session's audio; null if kept forever. */
function retainedUntil(manifest: Manifest): string | null {
  const days = getSettings().audioRetentionDays
  if (days === null) return null
  const from = new Date(manifest.endedAt ?? manifest.updatedAt).getTime()
  return new Date(from + days * 86_400_000).toISOString().slice(0, 10)
}

function sidecarOf(id: string, manifest: Manifest, snapshot: SessionSnapshot, body: string): unknown {
  const rel = (file: string): string => `.sessions/${id}/${file}`
  const talk = new Map<string, { seconds: number; segments: number }>()
  for (const segment of snapshot.transcript) {
    if (!segment.cluster) continue
    const sum = talk.get(segment.cluster) ?? { seconds: 0, segments: 0 }
    sum.seconds += Math.max(0, segment.end - segment.start)
    sum.segments++
    talk.set(segment.cluster, sum)
  }
  const ends = snapshot.transcript.map((segment) => segment.end)
  return {
    schema: SIDECAR_SCHEMA,
    id,
    export: id,
    generatedBy: `Lyra ${app.getVersion()}`,
    // The text file is an export: Lyra doesn't read edits back yet (docs/SESSION-MODEL.md).
    editable: false,
    title: snapshot.title || 'Untitled',
    tags: snapshot.tags,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    updatedAt: manifest.updatedAt,
    durationSeconds: manifest.tracks[0]?.seconds ?? (ends.length ? Math.max(...ends) : null),
    words: wordCount(body),
    audio:
      manifest.audio === 'kept'
        ? manifest.tracks.map((track) => ({
            track: track.name,
            path: rel(`audio/${track.file}`),
            sampleRate: track.sampleRate,
            seconds: +track.seconds.toFixed(2),
            retainedUntil: retainedUntil(manifest)
          }))
        : [],
    audioStatus: manifest.audio,
    rawTranscripts: manifest.passes.map((pass) => ({
      id: pass.id,
      kind: pass.kind,
      model: pass.model,
      createdAt: pass.createdAt,
      path: rel(`raw/${pass.id}.json`)
    })),
    speakers: snapshot.speakers.map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      personId: speaker.personId,
      confirmed: speaker.confirmed,
      confidence: speaker.confidence,
      matches: speaker.matches,
      talkSeconds: +(talk.get(speaker.id)?.seconds ?? 0).toFixed(1),
      segments: talk.get(speaker.id)?.segments ?? 0
    })),
    segments: snapshot.transcript.map((segment) => ({
      id: segment.id,
      rawId: segment.rawId,
      start: segment.start,
      end: segment.end,
      speaker: segment.cluster,
      confidence: segment.confidence,
      edited: segment.edited,
      text: segment.text,
      ...(segment.edited ? { original: segment.original } : {}),
      ...(segment.edits.length ? { edits: segment.edits } : {})
    }))
  }
}

/** Keeps a copy of an export that was changed outside Lyra, before it is overwritten. */
async function backUpExternalEdit(entry: Entry, current: string): Promise<void> {
  const dir = join(sessionDirIn(entry.root, entry.id), 'external')
  await mkdir(dir, { recursive: true })
  const name = `${timestampStem(new Date())}${extname(entry.id)}`
  await writeFile(join(dir, name), current, 'utf8')
  log('sessions', 'kept a copy of an outside edit before re-exporting', { id: entry.id, name })
}

const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null)

/**
 * Writes the export, its metadata file and the manifest, each only when it changed. `updatedAt`
 * moves only when the document did (the manifest's `dirty`), so a manifest-only change (audio
 * deleted by retention, a pass added) doesn't float an old session to the top of the list.
 */
async function writeExport(entry: Entry): Promise<void> {
  const generation = entry.generation
  const snapshot = snapshotOf(entry.doc)
  const body = exportBody(snapshot)
  const before = entry.manifest
  const updatedAt = before.dirty ? new Date().toISOString() : before.updatedAt
  const text = serializePage({ id: entry.id, title: snapshot.title || 'Untitled', body, updatedAt })
  const hash = sha256(text)
  const path = notePathIn(entry.root, entry.id)

  const existing = await readText(path)
  const existingHash = existing === null ? null : sha256(existing)
  const exportChanged = existingHash !== hash
  if (existing !== null && exportChanged && existingHash !== before.exportHash) {
    await backUpExternalEdit(entry, existing)
  }

  const fields = { updatedAt, ...docSummaryFields(snapshot), exportHash: hash }
  const sidecarFile = join(entry.root, sidecarName(entry.id, entry.root))
  const sidecarManifest = { ...entry.manifest, ...fields }
  const sidecar = `${JSON.stringify(sidecarOf(entry.id, sidecarManifest, snapshot, body), null, 2)}\n`
  const sidecarChanged = (await readText(sidecarFile)) !== sidecar

  if (exportChanged) {
    markOwnWrite(entry.id)
    await writeFileAtomic(path, text)
  }
  if (sidecarChanged) await writeFileAtomic(sidecarFile, sidecar)
  // Set only once the files are written, so a failed export stays dirty and is retried. Spread
  // over the current manifest: `updateManifest` may have changed it while this ran.
  entry.manifest = {
    ...entry.manifest,
    ...fields,
    // Changes that arrived while this export was being written still need one.
    dirty: entry.generation !== generation
  }
  const manifestChanged = JSON.stringify(entry.manifest) !== JSON.stringify(before)
  if (manifestChanged) writeManifest(entry)
  if (!exportChanged && !sidecarChanged && !manifestChanged) return
  notifyPagesChanged()
  emitChange({ kind: 'saved', id: entry.id, manifest: entry.manifest, snapshot })
}

// --- Change events -----------------------------------------------------------------

/** What other stores (the search index) follow: a session written, deleted or restored. */
export type SessionChange =
  | { kind: 'saved'; id: string; manifest: Manifest; snapshot: SessionSnapshot }
  | { kind: 'removed'; id: string }
  | { kind: 'restored'; id: string }

const changeListeners = new Set<(change: SessionChange) => void>()

export function onSessionChange(listener: (change: SessionChange) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function emitChange(change: SessionChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change)
    } catch (error) {
      log('sessions', 'a change listener failed', { id: change.id, error: String(error) })
    }
  }
}

// --- Public API -------------------------------------------------------------------

function pageOf(entry: Entry): Page {
  const snapshot = snapshotOf(entry.doc)
  return {
    id: entry.id,
    title: snapshot.title.trim() || 'Untitled',
    body: snapshot.notes,
    updatedAt: entry.manifest.updatedAt
  }
}

export async function listSessions(): Promise<PageSummary[]> {
  await ensurePagesDir()
  const entries = await readdir(notesDir(), { withFileTypes: true })
  const out: PageSummary[] = []
  for (const file of entries) {
    if (!file.isFile() || !isNoteName(file.name)) continue
    await creating.get(file.name)
    try {
      const live = openEntry(file.name)
      let manifest = live?.manifest ?? readManifest(file.name)
      if (!manifest || !existsSync(docPathIn(notesDir(), file.name))) {
        const entry = await acquire(file.name)
        manifest = entry.manifest
        release(entry)
      }
      out.push({
        id: file.name,
        title: manifest.title,
        updatedAt: manifest.updatedAt,
        preview: manifest.preview,
        tags: manifest.tags,
        speakers: manifest.speakers,
        startedAt: manifest.startedAt,
        seconds: manifest.tracks.find((track) => track.name === 'mic')?.seconds ?? null
      })
    } catch (error) {
      log('sessions', 'skipped unreadable note', { name: file.name, error: String(error) })
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getSessionPage(id: string): Promise<Page> {
  const entry = await acquire(id)
  try {
    return pageOf(entry)
  } finally {
    release(entry)
  }
}

/**
 * Replaces title and notes as a diff against the document, so edits made elsewhere in the
 * text since the caller read it survive. Used by main-process writers (meeting pipeline,
 * notes) until they write to the document directly.
 */
export async function saveSessionPage(input: Pick<Page, 'id' | 'title' | 'body'>): Promise<Page> {
  const entry = await acquire(input.id)
  try {
    const title = input.title.trim() === 'Untitled' ? '' : input.title
    editDoc(entry.doc, { title, notes: input.body }, ORIGIN_MAIN)
    await flushExport(entry)
    return pageOf(entry)
  } finally {
    release(entry)
  }
}

export type CreateSessionOptions = { startedAt?: string }

export async function createSession(options: CreateSessionOptions = {}): Promise<Page> {
  await ensurePagesDir()
  const started = options.startedAt ? new Date(options.startedAt) : new Date()
  const startedAt = Number.isNaN(started.getTime()) ? new Date() : started
  const stem = timestampStem(startedAt)
  const ext = getSettings().fileFormat
  const now = new Date().toISOString()
  const title = defaultTitle(startedAt)

  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`
    // A session folder left behind by a note deleted outside Lyra keeps its name taken, so a
    // new session never writes over (or inherits) its log, audio or passes.
    if (existsSync(sessionDirIn(notesDir(), id))) continue
    const text = serializePage({ id, title, body: '', updatedAt: now })
    // Until the session folder exists, listing and loading wait instead of mistaking the new
    // file for a note dropped in from outside.
    let done = (): void => undefined
    creating.set(id, new Promise<void>((resolve) => {
      done = resolve
    }))
    try {
      markOwnWrite(id)
      // `wx` claims the name, so two sessions started in the same second can't collide.
      await writeFile(resolveInNotes(id), text, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      creating.delete(id)
      done()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      const root = notesDir()
      const doc = new Y.Doc()
      initDoc(doc, { title, notes: '' }, ORIGIN_LOAD)
      // Synchronous from here on, so the session is complete before anyone else runs.
      mkdirSync(sessionDirIn(root, id), { recursive: true })
      // `wx`: never over a log that appeared since the check above.
      writeFileSync(docPathIn(root, id), frame(Y.encodeStateAsUpdate(doc)), { flag: 'wx' })
      const manifest: Manifest = {
        version: MANIFEST_VERSION,
        id,
        startedAt: startedAt.toISOString(),
        endedAt: null,
        updatedAt: now,
        tracks: [],
        passes: [],
        audio: 'none',
        title,
        titleAuto: true,
        preview: previewOf(''),
        tags: [],
        speakers: 0,
        exportHash: sha256(text),
        dirty: false
      }
      const entry = makeEntry({ id, root, doc, manifest, manifestRaw: undefined, frames: 1 })
      writeManifest(entry)
      emitChange({ kind: 'saved', id, manifest, snapshot: snapshotOf(doc) })
      open.set(keyOf(root, id), entry)
      release(entry)
      return pageOf(entry)
    } finally {
      creating.delete(id)
      done()
    }
  }
  throw new Error('Could not find a free file name for the new session')
}

/** Moves the export, its metadata and the session folder to the OS trash. */
export async function deleteSession(id: string): Promise<void> {
  resolveInNotes(id)
  const entry = openEntry(id)
  if (entry) {
    if (entry.exportTimer) clearTimeout(entry.exportTimer)
    if (entry.unloadTimer) clearTimeout(entry.unloadTimer)
    await entry.exporting
    open.delete(keyOf(entry.root, id))
    entry.doc.destroy()
  }
  markOwnWrite(id)
  // Set aside rather than trashed, so the window can undo the delete. What's set aside goes to
  // the system trash when Lyra quits (or on the next start, after a crash).
  const held = join(trashRoot(), id)
  await discard(held)
  await mkdir(held, { recursive: true })
  const moves: TrashMove[] = []
  const sidecar = sidecarName(id)
  const files: [string, string][] = [
    [resolveInNotes(id), 'note'],
    [join(notesDir(), sidecar), 'sidecar'],
    [join(sessionsRoot(), id), 'session']
  ]
  for (const [from, name] of files) {
    if (!existsSync(from)) continue
    const to = join(held, name)
    await rename(from, to)
    moves.push({ from, to })
  }
  trashed.set(id, { held, moves })
  emitChange({ kind: 'removed', id })
}

type TrashMove = { from: string; to: string }

/** Deleted sessions this run, by id: where each of their files went, to put them back. */
const trashed = new Map<string, { held: string; moves: TrashMove[] }>()

function trashRoot(): string {
  return join(sessionsRoot(), '.trash')
}

async function discard(path: string): Promise<void> {
  if (!existsSync(path)) return
  try {
    await shell.trashItem(path)
  } catch {
    // No trash available (some Linux setups, test runs): delete instead.
    await rm(path, { recursive: true, force: true })
  }
}

/** Undoes `deleteSession`: puts the note, its metadata and its session folder back. */
export async function restoreSession(id: string): Promise<void> {
  resolveInNotes(id)
  const entry = trashed.get(id)
  if (!entry) throw new Error('This session can no longer be restored')
  const { held, moves } = entry
  if (moves.some((move) => existsSync(move.from))) {
    throw new Error('A session with the same name exists again')
  }
  markOwnWrite(id)
  for (const move of moves) await rename(move.to, move.from)
  trashed.delete(id)
  await rm(held, { recursive: true, force: true })
  notifyPagesChanged()
  emitChange({ kind: 'restored', id })
}

/** Sends every deleted session to the system trash; they can't be undone after this. */
export async function emptySessionTrash(): Promise<void> {
  trashed.clear()
  const entries = await readdir(trashRoot()).catch(() => [])
  for (const name of entries) await discard(join(trashRoot(), name))
}

/** Opens a session for a window: returns the full state and sends it later changes. */
export async function openSessionFor(id: string, contentsId: number): Promise<Uint8Array> {
  const entry = await acquire(id)
  entry.subscribers.add(contentsId)
  watchContents(contentsId)
  release(entry)
  return Y.encodeStateAsUpdate(entry.doc)
}

export async function applySessionUpdate(
  id: string,
  update: unknown,
  contentsId: number
): Promise<void> {
  const bytes = asUpdate(update)
  if (bytes.byteLength > MAX_WINDOW_UPDATE_BYTES) {
    log('sessions', 'refused an oversized update from a window', { id, bytes: bytes.byteLength })
    throw new Error('Document update is too large')
  }
  // Decoded before it touches the document, so a malformed update is refused whole instead
  // of failing halfway through being applied.
  try {
    Y.decodeUpdate(bytes)
  } catch {
    log('sessions', 'refused a malformed update from a window', { id, bytes: bytes.byteLength })
    throw new Error('Malformed document update')
  }
  const entry = await acquire(id)
  try {
    // The window's id as origin, so its own change isn't echoed back to it.
    Y.applyUpdate(entry.doc, bytes, contentsId)
  } catch (error) {
    // What was applied before the throw was persisted by the update handler, so the log and
    // the document still agree.
    log('sessions', 'could not apply an update from a window', { id, error: String(error) })
    throw error
  } finally {
    release(entry)
  }
}

/**
 * Runs `change` on a session's document as a main-process writer (meeting pipeline, notes,
 * speaker naming) and writes the export once it's done.
 */
export async function editSession<T>(id: string, change: (doc: Y.Doc) => T): Promise<T> {
  const entry = await acquire(id)
  try {
    const result = change(entry.doc)
    await flushExport(entry)
    return result
  } finally {
    release(entry)
  }
}

/**
 * Like `editSession`, but leaves the export to its usual debounce: for frequent writers (the
 * live transcriber) that shouldn't rewrite the text file on every change.
 */
export async function changeSession<T>(id: string, change: (doc: Y.Doc) => T): Promise<T> {
  const entry = await acquire(id)
  try {
    return change(entry.doc)
  } finally {
    release(entry)
  }
}

/**
 * Sets a title Lyra came up with (an AI suggestion), unless the user has set their own since
 * the session started. Returns whether it was set.
 */
export async function setAutoTitle(id: string, title: string): Promise<boolean> {
  const entry = await acquire(id)
  try {
    if (!entry.manifest.titleAuto) return false
    editDoc(entry.doc, { title }, ORIGIN_AUTO_TITLE)
    await flushExport(entry)
    return true
  } finally {
    release(entry)
  }
}

export async function readSession(id: string): Promise<SessionSnapshot> {
  const entry = await acquire(id)
  try {
    return snapshotOf(entry.doc)
  } finally {
    release(entry)
  }
}

/** Updates a session's manifest (recording finished, pass added, audio deleted). */
export async function updateManifest(id: string, change: (manifest: Manifest) => Manifest): Promise<void> {
  const entry = await acquire(id)
  try {
    entry.manifest = change(entry.manifest)
    writeManifest(entry)
    scheduleExport(entry, EXPORT_DELAY_MS)
  } finally {
    release(entry)
  }
}

export type { Manifest as SessionManifest }

export async function readManifestOf(id: string): Promise<Manifest> {
  const entry = await acquire(id)
  try {
    return entry.manifest
  } finally {
    release(entry)
  }
}

/** A session's manifest straight from disk, without loading its document. */
export function peekManifest(id: string): Manifest | null {
  return openEntry(id)?.manifest ?? readManifest(id)
}

/** Ids of every session folder, whether or not its note still exists (retention sweep). */
export async function sessionIds(): Promise<string[]> {
  const entries = await readdir(sessionsRoot(), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && isNoteName(entry.name)).map((entry) => entry.name)
}

/** Rebuilds a session from its log on disk, bypassing memory (checks and debugging). */
export async function readSessionFromDisk(id: string): Promise<SessionSnapshot> {
  const doc = new Y.Doc()
  applyLog(doc, await readFile(docPathIn(notesDir(), id)), ORIGIN_LOAD)
  const snapshot = snapshotOf(doc)
  doc.destroy()
  return snapshot
}

export function sidecarPath(id: string): string {
  return join(notesDir(), sidecarName(id))
}

const watched = new Set<number>()

/** Drops a window's subscriptions when it goes away, so idle documents can unload. */
function watchContents(contentsId: number): void {
  if (watched.has(contentsId)) return
  const target = webContents.fromId(contentsId)
  if (!target) return
  watched.add(contentsId)
  target.once('destroyed', () => {
    watched.delete(contentsId)
    for (const entry of open.values()) {
      if (entry.subscribers.delete(contentsId)) {
        entry.refs++
        release(entry)
      }
    }
  })
}

export function closeSessionFor(id: string, contentsId: number): void {
  const entry = openEntry(id)
  if (!entry) return
  entry.subscribers.delete(contentsId)
  entry.refs++
  release(entry)
}

/** Writes pending exports and compacts logs; called on quit. Safe to call twice. */
export async function flushAllSessions(): Promise<void> {
  for (const entry of [...open.values()]) {
    await flushExport(entry).catch(() => undefined)
    try {
      if (entry.frames > 1) compact(entry)
    } catch (error) {
      log('sessions', 'compaction failed', { id: entry.id, error: String(error) })
    }
  }
}

/**
 * Writes pending exports and closes every open session; await it before the notes folder
 * changes, so nothing is still writing into the old folder while its files move. A session in
 * use right now (a recording, an edit in flight) keeps writing to the folder it came from and
 * is closed once released; the next open of that id reads the new folder.
 */
export async function closeAllSessions(): Promise<void> {
  await Promise.allSettled([...loading.values()])
  for (const [key, entry] of [...open]) {
    open.delete(key)
    entry.closed = true
    entry.subscribers.clear()
    if (entry.unloadTimer) clearTimeout(entry.unloadTimer)
    entry.unloadTimer = null
    if (inUse(entry)) {
      await flushExport(entry).catch(() => undefined)
      continue
    }
    await unload(entry).catch((error: unknown) => {
      log('sessions', 'could not close a session', { id: entry.id, error: String(error) })
    })
  }
  manifestCache.clear()
}

/**
 * Exports sessions left dirty by a crash mid-export: their text file is behind their document.
 * Call once at startup; otherwise they wait until someone opens them.
 */
export async function reexportDirtySessions(): Promise<number> {
  const root = notesDir()
  let exported = 0
  for (const id of await sessionIds()) {
    // A session whose note is gone (deleted outside Lyra) has nowhere to export to.
    if (!existsSync(join(root, id))) continue
    try {
      if (!peekManifest(id)?.dirty) continue
      const entry = await acquire(id)
      try {
        await flushExport(entry)
      } finally {
        release(entry)
      }
      exported++
    } catch (error) {
      log('sessions', 'could not re-export a session', { id, error: String(error) })
    }
  }
  if (exported) log('sessions', 're-exported sessions left dirty', { sessions: exported })
  return exported
}

/** Moves a note's session folder and metadata along with it (Settings → change folder). */
export async function moveSessionFiles(fromDir: string, id: string): Promise<void> {
  const fromSession = join(fromDir, '.sessions', id)
  if (existsSync(fromSession)) {
    await mkdir(sessionsRoot(), { recursive: true })
    await copyDir(fromSession, join(sessionsRoot(), id))
    await rm(fromSession, { recursive: true, force: true })
  }
  const stem = stemOf(id)
  for (const name of [`${stem}.lyra.json`, `${id}.lyra.json`]) {
    const from = join(fromDir, name)
    if (!existsSync(from)) continue
    await copyFile(from, join(notesDir(), name))
    await unlink(from)
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else await copyFile(source, target)
  }
}

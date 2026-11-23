import { app, shell, webContents } from 'electron'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import * as Y from 'yjs'
import type { Page, PageSummary } from '../shared/types'
import {
  asUpdate,
  editDoc,
  initDoc,
  replaceTranscript,
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

const MANIFEST_VERSION = 1
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

type Manifest = {
  version: typeof MANIFEST_VERSION
  id: string
  startedAt: string
  endedAt: string | null
  updatedAt: string
  tracks: { name: 'mic' | 'system'; file: string; sampleRate: number; seconds: number }[]
  passes: { id: string; kind: 'live' | 'diarized'; createdAt: string; model: string }[]
  audio: 'none' | 'kept' | 'deleted'
  /** Cached for the list view, so it never has to load documents. */
  title: string
  /** The title is Lyra's (the start time, or an AI suggestion), not one the user typed. */
  titleAuto: boolean
  preview: string
  tags: string[]
  /** Distinct speakers in the transcript; 0 without one. */
  speakers: number
  /** sha256 of the export as last written, to spot edits made outside Lyra. */
  exportHash: string | null
  /** The document changed since the last export (e.g. Lyra quit mid-debounce). */
  dirty: boolean
}

type Entry = {
  id: string
  doc: Y.Doc
  manifest: Manifest
  frames: number
  refs: number
  /** webContents ids that hold a replica and want updates. */
  subscribers: Set<number>
  exportTimer: ReturnType<typeof setTimeout> | null
  unloadTimer: ReturnType<typeof setTimeout> | null
  exporting: Promise<void>
}

const open = new Map<string, Entry>()

// --- Paths ------------------------------------------------------------------

export function sessionsRoot(): string {
  return join(notesDir(), '.sessions')
}

function sessionDir(id: string): string {
  resolveInNotes(id)
  return join(sessionsRoot(), id)
}

const manifestPath = (id: string): string => join(sessionDir(id), 'session.json')
const docPath = (id: string): string => join(sessionDir(id), 'doc.yjs')
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
  /** Live passes: every speaker decision, so a mislabeled session can be replayed and debugged. */
  trace?: LiveTraceEvent[]
}

/**
 * One live speaker-identification decision. `voice`: a stretch of speech was voiceprinted and
 * scored against every voice so far (`scores`), then joined one, started one, or (`reuse`, `held`)
 * took the previous speaker without a voiceprint. `merge` and `fold` fold one voice into another.
 */
export type LiveTraceEvent =
  | {
      kind: 'voice'
      start: number
      end: number
      cluster: string | null
      decision: 'join' | 'new' | 'reuse' | 'held'
      scores: Record<string, number>
      embedding: number[]
    }
  | { kind: 'merge'; at: number; from: string; into: string; score: number }
  | { kind: 'fold'; from: string; into: string }

export type TrackInfo = Manifest['tracks'][number]

const stemOf = (id: string): string => id.slice(0, -extname(id).length)

/** `<stem>.lyra.json`, unless a note with the same stem and another extension exists. */
function sidecarName(id: string): string {
  const stem = stemOf(id)
  const twin = ['.txt', '.md'].some(
    (ext) => ext !== extname(id).toLowerCase() && existsSync(join(notesDir(), stem + ext))
  )
  return twin ? `${id}.lyra.json` : `${stem}.lyra.json`
}

// --- Manifest ---------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string'

function readManifest(id: string): Manifest | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(manifestPath(id), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const m = raw as Record<string, unknown>
    if (m.version !== MANIFEST_VERSION || m.id !== id) return null
    return {
      version: MANIFEST_VERSION,
      id,
      startedAt: isString(m.startedAt) ? m.startedAt : new Date().toISOString(),
      endedAt: isString(m.endedAt) ? m.endedAt : null,
      updatedAt: isString(m.updatedAt) ? m.updatedAt : new Date().toISOString(),
      tracks: Array.isArray(m.tracks) ? (m.tracks as Manifest['tracks']) : [],
      passes: Array.isArray(m.passes) ? (m.passes as Manifest['passes']) : [],
      audio: m.audio === 'kept' || m.audio === 'deleted' ? m.audio : 'none',
      title: isString(m.title) ? m.title : 'Untitled',
      // Sessions from before this flag keep their title, unless they never had one.
      titleAuto: typeof m.titleAuto === 'boolean' ? m.titleAuto : !isString(m.title) || m.title === 'Untitled',
      preview: isString(m.preview) ? m.preview : '',
      tags: Array.isArray(m.tags) ? m.tags.filter(isString) : [],
      speakers: typeof m.speakers === 'number' ? m.speakers : 0,
      exportHash: isString(m.exportHash) ? m.exportHash : null,
      dirty: m.dirty === true
    }
  } catch {
    return null
  }
}

/** Atomic: write a temp file, then rename over the old one. */
function writeManifest(manifest: Manifest): void {
  const path = manifestPath(manifest.id)
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(manifest, null, 2), 'utf8')
  renameSync(temp, path)
}

// --- Update log -------------------------------------------------------------

/** One frame: a 4-byte little-endian length, then the update. */
function frame(update: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + update.byteLength)
  out.writeUInt32LE(update.byteLength, 0)
  Buffer.from(update.buffer, update.byteOffset, update.byteLength).copy(out, 4)
  return out
}

function readFrames(buffer: Buffer): Uint8Array[] {
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 4 <= buffer.byteLength) {
    const length = buffer.readUInt32LE(offset)
    const end = offset + 4 + length
    // A torn last frame (crash mid-write) is dropped; everything before it is intact.
    if (end > buffer.byteLength) break
    frames.push(new Uint8Array(buffer.subarray(offset + 4, end)))
    offset = end
  }
  return frames
}

function compact(entry: Entry): void {
  const path = docPath(entry.id)
  const temp = `${path}.tmp`
  writeFileSync(temp, frame(Y.encodeStateAsUpdate(entry.doc)))
  renameSync(temp, path)
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

type LegacyMeta = {
  speakers: { cluster: number; name: string; personId: string | null; embedding: number[] }[]
  liveTranscript: string
}

async function readLegacyMeta(id: string): Promise<LegacyMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(notesDir(), '.meta', `${stemOf(id)}.json`), 'utf8'))
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
async function migrateLegacyMeeting(id: string, doc: Y.Doc, body: string, meta: LegacyMeta): Promise<{
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

  const raw = sessionRawDir(id)
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
  for (const name of ['mic', 'system'] as const) {
    const from = join(notesDir(), '.audio', `${stemOf(id)}.${name}.wav`)
    if (!existsSync(from)) continue
    await mkdir(sessionAudioDir(id), { recursive: true })
    const to = join(sessionAudioDir(id), `${name}.wav`)
    await copyFile(from, to)
    await unlink(from)
    const size = (await stat(to)).size
    tracks.push({ name, file: `${name}.wav`, sampleRate: 16000, seconds: Math.max(0, size - 44) / BYTES_PER_SECOND })
  }
  await rename(join(notesDir(), '.meta', `${stemOf(id)}.json`), join(notesDir(), '.meta', `${stemOf(id)}.json.migrated`)).catch(() => undefined)
  log('sessions', 'migrated a labeled meeting', { id, segments: segments.length, tracks: tracks.length })
  return { notes: leftover.join('\n').trim(), tracks, passes }
}

/** A note file with no session yet (older Lyra, or dropped in from outside) becomes one. */
async function migrateNote(id: string): Promise<Entry> {
  const path = resolveInNotes(id)
  const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  const page = parsePage(raw, id, info.mtime.toISOString())
  const doc = new Y.Doc()
  initDoc(doc, { title: page.title === 'Untitled' ? '' : page.title, notes: '' }, ORIGIN_LOAD)
  mkdirSync(sessionDir(id), { recursive: true })
  const legacy = await readLegacyMeta(id)
  const meeting = legacy ? await migrateLegacyMeeting(id, doc, page.body, legacy) : null
  editDoc(doc, { notes: meeting ? meeting.notes : page.body }, ORIGIN_LOAD)
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    id,
    startedAt: startedAtFromId(id, info.birthtime),
    endedAt: null,
    updatedAt: page.updatedAt,
    tracks: meeting?.tracks ?? [],
    passes: meeting?.passes ?? [],
    audio: meeting?.tracks.length ? 'kept' : 'none',
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
  writeFileSync(docPath(id), frame(Y.encodeStateAsUpdate(doc)))
  writeManifest(manifest)
  log('sessions', 'created session from note', { id })
  return makeEntry(id, doc, manifest, 1)
}

function makeEntry(id: string, doc: Y.Doc, manifest: Manifest, frames: number): Entry {
  const entry: Entry = {
    id,
    doc,
    manifest,
    frames,
    refs: 0,
    subscribers: new Set(),
    exportTimer: null,
    unloadTimer: null,
    exporting: Promise.resolve()
  }
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    onDocUpdate(entry, update, origin)
  })
  docTitle(doc).observe((_event, transaction) => {
    onTitleChange(entry, transaction.origin)
  })
  return entry
}

async function load(id: string): Promise<Entry> {
  const manifest = readManifest(id)
  if (!manifest || !existsSync(docPath(id))) return migrateNote(id)
  const doc = new Y.Doc()
  const frames = readFrames(await readFile(docPath(id)))
  doc.transact(() => {
    for (const update of frames) Y.applyUpdate(doc, update)
  }, ORIGIN_LOAD)
  const entry = makeEntry(id, doc, manifest, frames.length)
  if (manifest.dirty) scheduleExport(entry, 0)
  return entry
}

const loading = new Map<string, Promise<Entry>>()

/** Sessions whose note file exists but whose folder is still being written. */
const creating = new Map<string, Promise<void>>()

async function acquire(id: string): Promise<Entry> {
  resolveInNotes(id)
  await creating.get(id)
  let entry = open.get(id)
  if (!entry) {
    let pending = loading.get(id)
    if (!pending) {
      pending = load(id)
      loading.set(id, pending)
    }
    try {
      const loaded = await pending
      // Someone else opened it meanwhile (e.g. it was just created): theirs wins.
      entry = open.get(id) ?? loaded
    } finally {
      loading.delete(id)
    }
    open.set(id, entry)
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

async function unload(entry: Entry): Promise<void> {
  if (entry.refs > 0 || entry.subscribers.size > 0 || open.get(entry.id) !== entry) return
  await flushExport(entry)
  try {
    if (entry.frames > 1) compact(entry)
  } catch (error) {
    log('sessions', 'compaction failed', { id: entry.id, error: String(error) })
  }
  open.delete(entry.id)
  entry.doc.destroy()
}

// --- Changes ------------------------------------------------------------------

function onDocUpdate(entry: Entry, update: Uint8Array, origin: unknown): void {
  if (origin === ORIGIN_LOAD) return
  try {
    appendFileSync(docPath(entry.id), frame(update))
    entry.frames++
    if (entry.frames >= COMPACT_AFTER) compact(entry)
  } catch (error) {
    log('sessions', 'could not persist update', { id: entry.id, error: String(error) })
  }
  if (!entry.manifest.dirty) {
    entry.manifest.dirty = true
    writeManifest(entry.manifest)
  }
  const from = typeof origin === 'number' ? origin : null
  for (const id of entry.subscribers) {
    if (id === from) continue
    const target = webContents.fromId(id)
    if (!target || target.isDestroyed()) entry.subscribers.delete(id)
    else target.send('sessions:update', { id: entry.id, update })
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
  writeManifest(entry.manifest)
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
    entry.exporting = entry.exporting.then(() => writeExport(entry))
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

function sidecarOf(entry: Entry, snapshot: SessionSnapshot, body: string): unknown {
  const { manifest } = entry
  const rel = (file: string): string => `.sessions/${entry.id}/${file}`
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
    id: entry.id,
    export: entry.id,
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
  const dir = join(sessionDir(entry.id), 'external')
  await mkdir(dir, { recursive: true })
  const name = `${timestampStem(new Date())}${extname(entry.id)}`
  await writeFile(join(dir, name), current, 'utf8')
  log('sessions', 'kept a copy of an outside edit before re-exporting', { id: entry.id, name })
}

async function writeExport(entry: Entry): Promise<void> {
  const snapshot = snapshotOf(entry.doc)
  const body = exportBody(snapshot)
  const updatedAt = new Date().toISOString()
  const text = serializePage({ id: entry.id, title: snapshot.title || 'Untitled', body, updatedAt })
  const path = resolveInNotes(entry.id)

  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing !== null && entry.manifest.exportHash && sha256(existing) !== entry.manifest.exportHash) {
    await backUpExternalEdit(entry, existing)
  }

  entry.manifest = {
    ...entry.manifest,
    updatedAt,
    title: snapshot.title.trim() || 'Untitled',
    // The words people said, not the export's transcript heading.
    preview: previewOf(
      snapshot.notes.trim() ||
        snapshot.summary.trim() ||
        snapshot.transcript.map((line) => line.text).join(' ')
    ),
    tags: snapshot.tags,
    speakers: new Set(snapshot.transcript.flatMap((line) => (line.cluster ? [line.cluster] : []))).size,
    exportHash: sha256(text),
    dirty: false
  }
  markOwnWrite(entry.id)
  await writeFile(path, text, 'utf8')
  await writeFile(
    join(notesDir(), sidecarName(entry.id)),
    `${JSON.stringify(sidecarOf(entry, snapshot, body), null, 2)}\n`,
    'utf8'
  )
  writeManifest(entry.manifest)
  notifyPagesChanged()
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
      const live = open.get(file.name)
      let manifest = live?.manifest ?? readManifest(file.name)
      if (!manifest || !existsSync(docPath(file.name))) {
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
      const doc = new Y.Doc()
      initDoc(doc, { title, notes: '' }, ORIGIN_LOAD)
      // Synchronous from here on, so the session is complete before anyone else runs.
      mkdirSync(sessionDir(id), { recursive: true })
      writeFileSync(docPath(id), frame(Y.encodeStateAsUpdate(doc)))
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
      writeManifest(manifest)
      const entry = makeEntry(id, doc, manifest, 1)
      open.set(id, entry)
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
  const entry = open.get(id)
  if (entry) {
    if (entry.exportTimer) clearTimeout(entry.exportTimer)
    if (entry.unloadTimer) clearTimeout(entry.unloadTimer)
    await entry.exporting
    open.delete(id)
    entry.doc.destroy()
  }
  markOwnWrite(id)
  const sidecar = join(notesDir(), sidecarName(id))
  for (const path of [resolveInNotes(id), sidecar, join(sessionsRoot(), id)]) {
    if (!existsSync(path)) continue
    try {
      await shell.trashItem(path)
    } catch {
      // No trash available (some Linux setups, test runs): delete instead.
      await rm(path, { recursive: true, force: true })
    }
  }
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
  const entry = await acquire(id)
  try {
    // The window's id as origin, so its own change isn't echoed back to it.
    Y.applyUpdate(entry.doc, bytes, contentsId)
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
    writeManifest(entry.manifest)
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
  return open.get(id)?.manifest ?? readManifest(id)
}

/** Ids of every session folder, whether or not its note still exists (retention sweep). */
export async function sessionIds(): Promise<string[]> {
  const entries = await readdir(sessionsRoot(), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && isNoteName(entry.name)).map((entry) => entry.name)
}

/** Rebuilds a session from its log on disk, bypassing memory (checks and debugging). */
export async function readSessionFromDisk(id: string): Promise<SessionSnapshot> {
  const doc = new Y.Doc()
  for (const update of readFrames(await readFile(docPath(id)))) Y.applyUpdate(doc, update)
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
  const entry = open.get(id)
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

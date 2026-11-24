import { BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AudioTrack, MeetingRecording, TranscriptWord } from '../shared/types'
import { getSettings } from './settings'
import { log } from './log'
import { notifyLabeled } from './meeting/events'
import { LiveSession, type LiveResult } from './meeting/live'
import { resolveInNotes } from './pages'
import {
  sessionAudioDir,
  sessionRawDir,
  updateManifest,
  type LiveTraceEvent,
  type RawPass,
  type TrackInfo
} from './sessionStore'

/**
 * Records every session's audio as it is captured: one 16 kHz mono 16-bit WAV per track
 * (mic, system) in `.sessions/<id>/audio/`. Recording again in the same session appends to the
 * same files, so a session has one timeline; tracks are padded with silence to stay aligned.
 * Words the live transcriber commits are kept on that timeline in `raw/live.json`.
 */

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const HEADER_BYTES = 44
const TRACKS: readonly AudioTrack[] = ['mic', 'system']
const LIVE_MODEL = 'whisper base (streaming)'

type TrackFile = { path: string; stream: WriteStream; bytes: number }
type LiveSegment = RawPass['segments'][number]
type Recording = {
  pageId: string
  /** Where this take starts on the session timeline, in seconds. */
  offset: number
  tracks: Map<AudioTrack, TrackFile>
  live: LiveSegment[]
  /** Places the live words: notes for one voice, speaker-labeled lines once there are two. */
  session: LiveSession
}

let active: Recording | null = null
/** Off in test runs: identifying speakers needs the downloaded models. */
let identifySpeakers = true
const listeners = new Set<(recording: MeetingRecording) => void>()

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export function trackPath(pageId: string, track: AudioTrack): string {
  return join(sessionAudioDir(pageId), `${track}.wav`)
}

async function dataBytes(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  const size = (await stat(path)).size
  // Whole samples only: a torn last write from a crash is dropped.
  const data = Math.max(0, size - HEADER_BYTES)
  return data - (data % 2)
}

const SILENCE_CHUNK = Buffer.alloc(BYTES_PER_SECOND)

function writeSilence(file: TrackFile, bytes: number): void {
  let left = bytes
  while (left > 0) {
    const n = Math.min(left, SILENCE_CHUNK.byteLength)
    file.stream.write(SILENCE_CHUNK.subarray(0, n))
    file.bytes += n
    left -= n
  }
}

/** Opens a track to append to, creating it (with `pad` bytes of silence) if it's new. */
async function openTrack(pageId: string, track: AudioTrack, pad: number): Promise<TrackFile> {
  const path = trackPath(pageId, track)
  const existing = await dataBytes(path)
  if (existing > 0) {
    // The header is rewritten with the full length when recording stops.
    return { path, stream: createWriteStream(path, { flags: 'r+', start: HEADER_BYTES + existing }), bytes: existing }
  }
  const stream = createWriteStream(path)
  stream.write(wavHeader(0))
  const file = { path, stream, bytes: 0 }
  writeSilence(file, pad)
  return file
}

async function start(pageId: string, withSystem: boolean): Promise<number> {
  resolveInNotes(pageId)
  if (active) await stop()
  await mkdir(sessionAudioDir(pageId), { recursive: true })
  const micBytes = await dataBytes(trackPath(pageId, 'mic'))
  const tracks = new Map<AudioTrack, TrackFile>([['mic', await openTrack(pageId, 'mic', 0)]])
  if (withSystem) tracks.set('system', await openTrack(pageId, 'system', micBytes))
  const offset = micBytes / BYTES_PER_SECOND
  const session = new LiveSession(pageId, tracks.has('system'), identifySpeakers)
  await session.begin()
  active = { pageId, offset, tracks, live: [], session }
  log('recorder', 'started', { pageId, tracks: [...tracks.keys()], offset: active.offset })
  return active.offset
}

function append(track: AudioTrack, payload: unknown): void {
  const file = active?.tracks.get(track)
  if (!file) return
  if (!ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) return
  const bytes = ArrayBuffer.isView(payload)
    ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    : Buffer.from(payload)
  if (bytes.byteLength % 2 !== 0) return
  const recording = active
  if (recording) {
    const samples = new Int16Array(bytes.byteLength / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
    recording.session.audio(track, file.bytes / BYTES_PER_SECOND, samples)
  }
  file.stream.write(bytes)
  file.bytes += bytes.byteLength
}

function isWord(value: unknown): value is TranscriptWord {
  if (!value || typeof value !== 'object') return false
  const word = value as Record<string, unknown>
  return typeof word.text === 'string' && typeof word.start === 'number' && typeof word.end === 'number'
}

/** Committed live words, already on the session timeline (the renderer adds the offset). */
function appendWords(payload: unknown): void {
  const recording = active
  if (!recording || !Array.isArray(payload)) return
  const words = payload.filter(isWord).map((word) => ({
    text: word.text,
    start: +word.start.toFixed(3),
    end: +word.end.toFixed(3)
  }))
  const first = words[0]
  const last = words.at(-1)
  if (!first || !last) return
  recording.session.words(words)
  recording.live.push({
    id: `live-${String(Math.round(first.start * 1000))}`,
    start: first.start,
    end: last.end,
    // The transcriber hears both tracks mixed when there is a system track (`capture.ts`).
    track: recording.tracks.has('system') ? 'mix' : 'mic',
    cluster: null,
    confidence: null,
    words
  })
}

/** A committed phrase of live text and where on the session timeline it was heard. */
function appendText(text: unknown, start: unknown, end: unknown): void {
  if (!active || typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') return
  if (!Number.isFinite(start) || !Number.isFinite(end)) return
  active.session.text(text, start, end)
}

/** Which voice each live word segment was, from the spans the live session identified. */
function labelSegments(segments: LiveSegment[], result: LiveResult): LiveSegment[] {
  return segments.map((segment) => {
    let best: LiveResult['spans'][number] | undefined
    let overlap = 0
    for (const span of result.spans) {
      const shared = Math.min(span.end, segment.end) - Math.max(span.start, segment.start)
      if (shared > overlap) {
        best = span
        overlap = shared
      }
    }
    return best ? { ...segment, cluster: best.cluster, confidence: best.confidence } : segment
  })
}

async function finalize(file: TrackFile): Promise<void> {
  file.stream.end()
  await finished(file.stream)
  const handle = await open(file.path, 'r+')
  try {
    await handle.write(wavHeader(file.bytes), 0, HEADER_BYTES, 0)
  } finally {
    await handle.close()
  }
}

/** Merges this take's live words and voiceprints into `raw/live.json`. */
async function saveLivePass(
  pageId: string,
  segments: LiveSegment[],
  clusters: RawPass['clusters'],
  trace: LiveTraceEvent[]
): Promise<boolean> {
  if (!segments.length && !clusters.length) return false
  const dir = sessionRawDir(pageId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'live.json')
  let previous: LiveSegment[] = []
  let previousClusters: RawPass['clusters'] = []
  let previousTrace: LiveTraceEvent[] = []
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const list = (parsed as { segments?: unknown }).segments
    if (Array.isArray(list)) previous = list as LiveSegment[]
    const known = (parsed as { clusters?: unknown }).clusters
    if (Array.isArray(known)) previousClusters = known as RawPass['clusters']
    const traced = (parsed as { trace?: unknown }).trace
    if (Array.isArray(traced)) previousTrace = traced as LiveTraceEvent[]
  } catch {
    // First take.
  }
  const pass: RawPass = {
    id: 'live',
    kind: 'live',
    model: LIVE_MODEL,
    createdAt: new Date().toISOString(),
    segments: [...previous, ...segments],
    // A voice heard again keeps its newest voiceprint.
    clusters: [
      ...previousClusters.filter((cluster) => !clusters.some((entry) => entry.id === cluster.id)),
      ...clusters
    ],
    trace: [...previousTrace, ...trace]
  }
  await writeFile(path, JSON.stringify(pass), 'utf8')
  return true
}

async function stop(): Promise<MeetingRecording | null> {
  const recording = active
  if (!recording) return null
  active = null
  const mic = recording.tracks.get('mic')
  let system = recording.tracks.get('system')
  // A system track from an earlier take keeps pace with the mic through this one.
  if (!system && existsSync(trackPath(recording.pageId, 'system')) && mic) {
    system = await openTrack(recording.pageId, 'system', 0)
  }
  if (mic && system && system.bytes < mic.bytes) writeSilence(system, mic.bytes - system.bytes)
  if (mic) await finalize(mic)
  if (system) await finalize(system)
  const seconds = (mic?.bytes ?? 0) / BYTES_PER_SECOND
  const live = await recording.session.end()
  const hasLive = await saveLivePass(
    recording.pageId,
    labelSegments(recording.live, live),
    live.clusters,
    live.trace
  )

  const tracks: TrackInfo[] = [mic, system].flatMap((file, index) =>
    file ? [{ name: TRACKS[index] ?? 'mic', file: `${TRACKS[index] ?? 'mic'}.wav`, sampleRate: SAMPLE_RATE, seconds: file.bytes / BYTES_PER_SECOND }] : []
  )
  const endedAt = new Date().toISOString()
  await updateManifest(recording.pageId, (manifest) => ({
    ...manifest,
    endedAt,
    tracks,
    audio: 'kept',
    passes:
      hasLive && !manifest.passes.some((pass) => pass.id === 'live')
        ? [...manifest.passes, { id: 'live', kind: 'live', createdAt: endedAt, model: LIVE_MODEL }]
        : manifest.passes
  }))

  const result: MeetingRecording = {
    pageId: recording.pageId,
    micPath: mic?.path ?? '',
    systemPath: system?.path ?? null,
    seconds
  }
  log('recorder', 'stopped', {
    pageId: result.pageId,
    seconds: +seconds.toFixed(1),
    conversation: live.conversation,
    voices: live.clusters.length
  })
  // With speakers identified, relabeling (`meeting/relabel.ts`, a listener) still needs the
  // audio and announces the labeled session; without, the live words are final.
  if (!identifySpeakers) {
    if (getSettings().audioRetentionDays === 0) await deleteSessionAudio(recording.pageId)
    if (live.conversation) notifyLabeled(recording.pageId)
  }
  for (const listener of listeners) listener(result)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recorder:finished', result)
  return result
}

/** Deletes a session's audio tracks and records that in its manifest. */
export async function deleteSessionAudio(pageId: string): Promise<void> {
  if (active?.pageId === pageId) return
  for (const track of TRACKS) await unlink(trackPath(pageId, track)).catch(() => undefined)
  await updateManifest(pageId, (manifest) => ({
    ...manifest,
    audio: manifest.tracks.length ? 'deleted' : manifest.audio
  }))
}

/**
 * Stops a recording still running when the app quits, so its WAV headers carry the real length
 * and the manifest lists the tracks. Without this the audio of an interrupted take is unreadable.
 */
export async function finishRecordingForQuit(): Promise<void> {
  if (!active) return
  log('recorder', 'stopping for quit', { pageId: active.pageId })
  await stop()
}

/** The session being recorded right now, if any (retention never deletes its audio). */
export function recordingPageId(): string | null {
  return active?.pageId ?? null
}

/** Whether recordings identify speakers (off in test runs, which have no speaker models). */
export function identifiesSpeakers(): boolean {
  return identifySpeakers
}

/** Called with each finished recording (the speaker pipeline hooks in here). */
export function onRecordingFinished(listener: (recording: MeetingRecording) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The recorder's IPC entry points without a window, so a fixture can replay recorded audio
 * through exactly what a live recording runs (`meeting/replay.ts`).
 */
export const recorderFixture = {
  start: (pageId: string, withSystem: boolean): Promise<number> => {
    identifySpeakers = true
    return start(pageId, withSystem)
  },
  ready: (): Promise<void> => active?.session.whenReady() ?? Promise.resolve(),
  append,
  appendWords,
  appendText,
  stop
}

export function registerRecorderIpc(options: { identifySpeakers: boolean }): void {
  identifySpeakers = options.identifySpeakers
  ipcMain.handle('recorder:start', (_event, pageId: unknown, withSystem: unknown) => {
    if (typeof pageId !== 'string') throw new Error('Invalid page id')
    return start(pageId, withSystem === true)
  })
  ipcMain.on('recorder:append', (_event, track: unknown, payload: unknown) => {
    const name = TRACKS.find((entry) => entry === track)
    if (name) append(name, payload)
  })
  ipcMain.on('recorder:words', (_event, words: unknown) => {
    appendWords(words)
  })
  ipcMain.on('recorder:text', (_event, text: unknown, start: unknown, end: unknown) => {
    appendText(text, start, end)
  })
  ipcMain.handle('recorder:stop', () => stop())
}

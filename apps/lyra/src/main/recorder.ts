import { BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AudioTrack, MeetingRecording, TranscriptProgress } from '../shared/types'
import { getSettings } from './settings'
import { log } from './log'
import { notifyLabeled } from './meeting/events'
import { resolveInNotes } from './pages'
import { sessionAudioDir, sessionRawDir, updateManifest, type RawPass, type TrackInfo } from './sessionStore'
import { TakeWriter } from './takeWriter'
import { ChunkedTranscriber, type TranscribedChunk, type Transcribe } from './transcriber'
import { createSpeechClassifier, ensureSpeechVad } from './speechVad'
import { MODEL_LABEL, transcribePcm } from './whisper'

/**
 * Records every session's audio as it is captured: one 16 kHz mono 16-bit WAV per track
 * (mic, system) in `.sessions/<id>/audio/`. Recording again in the same session appends to the
 * same files, so a session has one timeline; tracks are padded with silence to stay aligned.
 * The audio is transcribed as it arrives, a chunk at a time (`transcriber.ts`), and the words are
 * kept on that timeline in `raw/live.json`.
 */

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const HEADER_BYTES = 44
const TRACKS: readonly AudioTrack[] = ['mic', 'system']

type TrackFile = { path: string; stream: WriteStream; bytes: number }
type LiveSegment = RawPass['segments'][number]
type Recording = {
  pageId: string
  /** Where this take starts on the session timeline, in seconds. */
  offset: number
  tracks: Map<AudioTrack, TrackFile>
  live: LiveSegment[]
  transcriber: ChunkedTranscriber
  writer: TakeWriter
  /** Chunks waiting for Whisper, as the window last heard. */
  queued: number
}

let active: Recording | null = null
/** How recordings are transcribed: the app's way, unless an eval asks for another (replay). */
export type TranscribeExperiment = { transcribe: Transcribe; carryContext: boolean }
const APP_TRANSCRIBE: TranscribeExperiment = { transcribe: transcribePcm, carryContext: true }
let experiment = APP_TRANSCRIBE
/** Off in test runs: identifying speakers needs the downloaded models. */
let identifySpeakers = true
/** Off in test runs too, which have no Whisper model; the audio is still recorded. */
let transcribeAudio = true
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
  const earlier = (await readLiveSegments(pageId)).flatMap((segment) =>
    segment.track === 'mix' ? [] : [{ track: segment.track, start: segment.start, end: segment.end }]
  )
  // Normally loaded by the window's warm-up already; replays and evals start here.
  if (transcribeAudio) await ensureSpeechVad()
  const writer = new TakeWriter(pageId, tracks.has('system'), earlier)
  const context = await writer.begin()
  const live: LiveSegment[] = []
  const recording: Recording = {
    pageId,
    offset,
    tracks,
    live,
    writer,
    queued: 0,
    transcriber: new ChunkedTranscriber(
      [...tracks.keys()],
      micBytes / 2,
      transcribeAudio ? experiment.transcribe : () => Promise.resolve([]),
      (chunk) => {
        live.push(segmentOf(chunk))
        writer.write(chunk)
      },
      (progress) => {
        reportProgress(recording, progress)
      },
      {
        context,
        classifier: transcribeAudio ? createSpeechClassifier : () => null,
        carryContext: experiment.carryContext
      }
    )
  }
  active = recording
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
  active?.transcriber.audio(track, toFloat(bytes))
  file.stream.write(bytes)
  file.bytes += bytes.byteLength
}

function toFloat(bytes: Buffer): Float32Array {
  const out = new Float32Array(bytes.byteLength / 2)
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768
  return out
}

/** A transcribed chunk as kept in `raw/live.json`, labeled with the track it was heard on. */
function segmentOf(chunk: TranscribedChunk): LiveSegment {
  return {
    id: `live-${chunk.track}-${String(Math.round(chunk.start * 1000))}`,
    start: chunk.words[0]?.start ?? chunk.start,
    end: chunk.words.at(-1)?.end ?? chunk.end,
    track: chunk.track,
    cluster: null,
    confidence: null,
    words: chunk.words
  }
}

function reportProgress(recording: Recording, progress: Omit<TranscriptProgress, 'pageId'>): void {
  if (progress.queued === recording.queued) return
  recording.queued = progress.queued
  const status: TranscriptProgress = { pageId: recording.pageId, ...progress }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('transcriber:progress', status)
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

/** Earlier takes' words in `raw/live.json` (none before the first take). */
async function readLiveSegments(pageId: string): Promise<LiveSegment[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(sessionRawDir(pageId), 'live.json'), 'utf8'))
    const list = (parsed as { segments?: unknown }).segments
    return Array.isArray(list) ? (list as LiveSegment[]) : []
  } catch {
    return []
  }
}

/** Merges this take's words into `raw/live.json`. */
async function saveLivePass(pageId: string, segments: LiveSegment[]): Promise<boolean> {
  if (!segments.length) return false
  const dir = sessionRawDir(pageId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'live.json')
  const previous = await readLiveSegments(pageId)
  const pass: RawPass = {
    id: 'live',
    kind: 'live',
    model: MODEL_LABEL,
    createdAt: new Date().toISOString(),
    segments: [...previous, ...segments],
    clusters: []
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
  // The last chunks are still being transcribed; their words belong to this take.
  await recording.transcriber.finish().catch((error: unknown) => {
    log('recorder', 'some audio could not be transcribed', { pageId: recording.pageId, error: String(error) })
  })
  const conversation = await recording.writer.end()
  const hasLive = await saveLivePass(recording.pageId, recording.live)

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
        ? [...manifest.passes, { id: 'live', kind: 'live', createdAt: endedAt, model: MODEL_LABEL }]
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
    conversation,
    ...recording.transcriber.stats()
  })
  // With speakers identified, relabeling (`meeting/relabel.ts`, a listener) still needs the
  // audio and announces the labeled session; without, the live words are final.
  if (!identifySpeakers) {
    if (getSettings().audioRetentionDays === 0) await deleteSessionAudio(recording.pageId)
    if (conversation) notifyLabeled(recording.pageId)
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
  start: (pageId: string, withSystem: boolean, transcribe: TranscribeExperiment = APP_TRANSCRIBE): Promise<number> => {
    identifySpeakers = true
    transcribeAudio = true
    experiment = transcribe
    return start(pageId, withSystem)
  },
  append,
  stop
}

export function registerRecorderIpc(options: { identifySpeakers: boolean; transcribe: boolean }): void {
  identifySpeakers = options.identifySpeakers
  transcribeAudio = options.transcribe
  ipcMain.handle('recorder:start', (_event, pageId: unknown, withSystem: unknown) => {
    if (typeof pageId !== 'string') throw new Error('Invalid page id')
    return start(pageId, withSystem === true)
  })
  ipcMain.on('recorder:append', (_event, track: unknown, payload: unknown) => {
    const name = TRACKS.find((entry) => entry === track)
    if (name) append(name, payload)
  })
  ipcMain.handle('recorder:stop', () => stop())
}

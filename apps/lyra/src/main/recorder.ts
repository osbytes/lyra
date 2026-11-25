import { BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AudioTrack, MeetingRecording, TranscriptProgress } from '../shared/types'
import { getSettings } from './settings'
import { heardSpans, mergeLivePass, readLiveFile, writeLiveFile, type LiveSegment } from './livePass'
import { log } from './log'
import { notifyLabeled } from './meeting/events'
import { resolveInNotes } from './pages'
import { sessionAudioDir, sessionRawDir, sessionsRoot, updateManifest, type TrackInfo } from './sessionStore'
import { TakeWriter } from './takeWriter'
import { ChunkedTranscriber, type TranscribedChunk, type Transcribe, type UnfinishedSpan } from './transcriber'
import { createSpeechClassifier, ensureSpeechVad } from './speechVad'
import {
  BYTES_PER_SECOND,
  dataBytesOf,
  HEADER_BYTES,
  patchHeader,
  repairSessionAudio,
  SAMPLE_RATE,
  wavHeader
} from './wavFile'
import { MODEL_LABEL, retryGpu, transcribePcm } from './whisper'

/**
 * Records every session's audio as it is captured: one 16 kHz mono 16-bit WAV per track
 * (mic, system) in `.sessions/<id>/audio/`. Recording again in the same session appends to the
 * same files, so a session has one timeline; tracks are padded with silence to stay aligned.
 * The audio is transcribed as it arrives, a chunk at a time (`transcriber.ts`), and the words are
 * kept on that timeline in `raw/live.json`.
 */

const TRACKS: readonly AudioTrack[] = ['mic', 'system']
/**
 * How often the WAV headers are brought up to date while recording, so a crash or power loss
 * leaves files any player reads to within a few seconds of the end (Lyra's reader goes to the end
 * of the file regardless). One 44-byte positional write per track.
 */
const HEADER_PATCH_MS = 5000
/**
 * How long quitting waits for Whisper to finish a recording's backlog. The app gives all of its
 * shutdown work 10 s (`QUIT_FLUSH_MS` in index.ts) and the session files need some of it; what
 * isn't transcribed by then is marked in `live.json` rather than silently lost.
 */
const QUIT_TRANSCRIBE_MS = 5000

type TrackFile = {
  track: AudioTrack
  path: string
  stream: WriteStream
  /** Audio bytes queued to the file, including what was there when it was opened. */
  bytes: number
  /** Audio bytes in the file when it was opened: the stream writes after them. */
  base: number
  /** Set when a write failed (disk full, the drive gone); nothing more is written. */
  error: Error | null
}
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
  headerTimer: ReturnType<typeof setInterval>
  /** The header write in progress, so stopping waits for it rather than racing it. */
  headerPatch: Promise<void>
  /** Whether `live.json` holds an untranscribed marker for this take, to clear when it's done. */
  marked: boolean
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

export function trackPath(pageId: string, track: AudioTrack): string {
  return join(sessionAudioDir(pageId), `${track}.wav`)
}

async function dataBytes(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  return dataBytesOf((await stat(path)).size)
}

/** Audio bytes the stream has handed to the OS so far (writes are whole samples). */
function onDisk(file: TrackFile): number {
  return file.base + file.stream.bytesWritten
}

const SILENCE_CHUNK = Buffer.alloc(BYTES_PER_SECOND)

function writeSilence(file: TrackFile, bytes: number): void {
  let left = bytes
  while (left > 0 && !file.error) {
    const n = Math.min(left, SILENCE_CHUNK.byteLength)
    file.stream.write(SILENCE_CHUNK.subarray(0, n))
    file.bytes += n
    left -= n
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A track's file stopped taking writes. Without a listener the stream's error would be an
 * uncaught exception in main, and every later sample would be dropped without a word. The
 * recording is stopped instead, keeping what reached the disk, and the windows are told.
 */
function trackFailed(file: TrackFile, error: Error): void {
  if (file.error) return
  file.error = error
  const code = 'code' in error ? String(error.code) : null
  log('recorder', 'could not write audio; stopping the recording', { track: file.track, code, error: error.message })
  const recording = active
  if (recording?.tracks.get(file.track) !== file) return
  const failure = { pageId: recording.pageId, track: file.track, message: error.message }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recorder:failed', failure)
  void stop().catch((stopError: unknown) => {
    log('recorder', 'could not stop the failed recording', { pageId: failure.pageId, error: errorMessage(stopError) })
  })
}

/**
 * Opens a track to append to, creating it if it's new, and pads it with silence to `padTo` bytes
 * so it lines up with the session's other track.
 */
async function openTrack(pageId: string, track: AudioTrack, padTo: number): Promise<TrackFile> {
  const path = trackPath(pageId, track)
  const exists = existsSync(path) && (await stat(path)).size >= HEADER_BYTES
  // The header goes in first, so the stream only ever appends audio and never touches it.
  if (!exists) await writeFile(path, wavHeader(0))
  const existing = exists ? await dataBytes(path) : 0
  const stream = createWriteStream(path, { flags: 'r+', start: HEADER_BYTES + existing })
  const file: TrackFile = { track, path, stream, bytes: existing, base: existing, error: null }
  stream.on('error', (error) => {
    trackFailed(file, error)
  })
  if (padTo > existing) writeSilence(file, padTo - existing)
  return file
}

/** Brings each track's header up to what is on disk, so the files read whole after a crash. */
async function patchHeaders(recording: Recording): Promise<void> {
  for (const file of recording.tracks.values()) {
    if (file.error) continue
    await patchHeader(file.path, onDisk(file)).catch((error: unknown) => {
      log('recorder', 'could not update a WAV header', { track: file.track, error: errorMessage(error) })
    })
  }
}

async function start(pageId: string, withSystem: boolean): Promise<number> {
  resolveInNotes(pageId)
  if (active) await stop()
  await mkdir(sessionAudioDir(pageId), { recursive: true })
  const micBytes = await dataBytes(trackPath(pageId, 'mic'))
  const systemBytes = await dataBytes(trackPath(pageId, 'system'))
  // A take cut short by a crash can leave one track longer than the other: both carry on from the
  // longer, so the mic and the system audio stay on one timeline.
  const aligned = Math.max(micBytes, systemBytes)
  const tracks = new Map<AudioTrack, TrackFile>([['mic', await openTrack(pageId, 'mic', aligned)]])
  try {
    if (withSystem) tracks.set('system', await openTrack(pageId, 'system', aligned))
    const offset = aligned / BYTES_PER_SECOND
    const existing = await readLiveFile(sessionRawDir(pageId))
    if (existing.state === 'corrupt') {
      log('recorder', 'live.json was unreadable; moved it aside', { pageId, aside: existing.aside })
    }
    const earlier = heardSpans(existing.state === 'ok' ? existing.file : null)
    // Normally loaded by the window's warm-up already; replays and evals start here.
    if (transcribeAudio) {
      await ensureSpeechVad()
      retryGpu()
    }
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
      headerPatch: Promise.resolve(),
      headerTimer: setInterval(() => {
        recording.headerPatch = recording.headerPatch.then(() => patchHeaders(recording))
      }, HEADER_PATCH_MS),
      marked: false,
      transcriber: new ChunkedTranscriber(
        [...tracks.keys()],
        aligned / 2,
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
    // Listed from the start, so a take a crash cuts short is still played back and expired.
    const listed = TRACKS.flatMap((track) => {
      const file = tracks.get(track)
      if (!file && !existsSync(trackPath(pageId, track))) return []
      const bytes = file?.bytes ?? (track === 'mic' ? micBytes : systemBytes)
      return [{ name: track, file: `${track}.wav`, sampleRate: SAMPLE_RATE, seconds: bytes / BYTES_PER_SECOND }]
    })
    await updateManifest(pageId, (manifest) => ({ ...manifest, tracks: listed, audio: 'kept' }))
    log('recorder', 'started', { pageId, tracks: [...tracks.keys()], offset })
    return offset
  } catch (error) {
    if (active?.tracks === tracks) {
      clearInterval(active.headerTimer)
      active = null
    }
    for (const file of tracks.values()) await finalize(file)
    throw error
  }
}

function trackInfo(files: Map<AudioTrack, TrackFile>, bytes?: Map<AudioTrack, number>): TrackInfo[] {
  return [...files.values()].map((file) => ({
    name: file.track,
    file: `${file.track}.wav`,
    sampleRate: SAMPLE_RATE,
    seconds: (bytes?.get(file.track) ?? file.bytes) / BYTES_PER_SECOND
  }))
}

function append(track: AudioTrack, payload: unknown): void {
  const file = active?.tracks.get(track)
  if (!file || file.error) return
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

function reportProgress(recording: Recording, progress: { queued: number }): void {
  if (progress.queued === recording.queued) return
  recording.queued = progress.queued
  const status: TranscriptProgress = { pageId: recording.pageId, queued: progress.queued }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('transcriber:progress', status)
}

/**
 * Closes a track and writes its header from the file's real length; returns the audio bytes.
 * After a failed write the header still describes what did reach the disk.
 */
async function finalize(file: TrackFile): Promise<number> {
  if (file.error) {
    file.stream.destroy()
  } else {
    file.stream.end()
    await finished(file.stream).catch((error: unknown) => {
      log('recorder', 'could not finish writing a track', { track: file.track, error: errorMessage(error) })
    })
  }
  const bytes = await dataBytes(file.path)
  await patchHeader(file.path, bytes).catch((error: unknown) => {
    log('recorder', 'could not write a WAV header', { track: file.track, error: errorMessage(error) })
  })
  return bytes
}

/**
 * Merges this take's words so far into `raw/live.json`, with a marker for the audio of the take
 * not transcribed yet. Saving again replaces both, so the take can be saved before Whisper is
 * done and again after. True when the take has words.
 */
async function saveLivePass(recording: Recording, unfinished: readonly UnfinishedSpan[]): Promise<boolean> {
  if (!recording.live.length && !unfinished.length && !recording.marked) return false
  const dir = sessionRawDir(recording.pageId)
  try {
    const existing = await readLiveFile(dir)
    if (existing.state === 'corrupt') {
      log('recorder', 'live.json was unreadable; moved it aside', { pageId: recording.pageId, aside: existing.aside })
    }
    const pass = mergeLivePass(existing.state === 'ok' ? existing.file : null, {
      model: MODEL_LABEL,
      createdAt: new Date().toISOString(),
      take: recording.offset,
      segments: recording.live,
      untranscribed: unfinished.map((span) => ({ take: recording.offset, ...span }))
    })
    await writeLiveFile(dir, pass)
    recording.marked = unfinished.length > 0
  } catch (error) {
    log('recorder', 'could not save the live words', { pageId: recording.pageId, error: errorMessage(error) })
  }
  return recording.live.length > 0
}

/** Waits for the take's transcription, up to `limitMs` when given; 'timeout' if it ran out. */
async function transcriptionDone(work: Promise<void>, pageId: string, limitMs?: number): Promise<'done' | 'timeout'> {
  const settled = work.then(
    () => 'done' as const,
    (error: unknown) => {
      log('recorder', 'some audio could not be transcribed', { pageId, error: String(error) })
      return 'done' as const
    }
  )
  if (limitMs === undefined) return settled
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
    }, limitMs)
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** `limitMs` bounds the wait for Whisper (quitting); otherwise every chunk is transcribed. */
async function stop(limitMs?: number): Promise<MeetingRecording | null> {
  const recording = active
  if (!recording) return null
  active = null
  clearInterval(recording.headerTimer)
  await recording.headerPatch
  const { pageId } = recording
  const mic = recording.tracks.get('mic')
  let system = recording.tracks.get('system')
  // A system track from an earlier take keeps pace with the mic through this one.
  if (!system && existsSync(trackPath(pageId, 'system')) && mic) {
    system = await openTrack(pageId, 'system', 0)
  }
  if (mic && system && system.bytes < mic.bytes) writeSilence(system, mic.bytes - system.bytes)
  const files = new Map<AudioTrack, TrackFile>()
  const bytes = new Map<AudioTrack, number>()
  for (const file of [mic, system]) {
    if (!file) continue
    files.set(file.track, file)
    bytes.set(file.track, await finalize(file))
  }
  const seconds = (bytes.get('mic') ?? 0) / BYTES_PER_SECOND
  const tracks = trackInfo(files, bytes)
  const endedAt = new Date().toISOString()

  // The audio is complete on disk: list it and save the words so far before waiting on Whisper,
  // so a quit or crash during the wait still leaves a take that plays and that retention sees.
  const transcribing = recording.transcriber.finish()
  let hasLive = await saveLivePass(recording, recording.transcriber.unfinished())
  await updateManifest(pageId, (manifest) => ({ ...manifest, endedAt, tracks, audio: 'kept' }))

  // The last chunks are still being transcribed; their words belong to this take.
  const outcome = await transcriptionDone(transcribing, pageId, limitMs)
  const unfinished = outcome === 'timeout' ? recording.transcriber.unfinished() : []
  if (unfinished.length) {
    // Not resumed on the next launch yet: the marker in live.json says what is missing.
    log('recorder', 'stopped before the transcription caught up', {
      pageId,
      untranscribed: unfinished.map((span) => ({ ...span, seconds: +(span.end - span.start).toFixed(1) }))
    })
  }
  const conversation = await recording.writer.end()
  hasLive = (await saveLivePass(recording, unfinished)) || hasLive
  if (hasLive) {
    await updateManifest(pageId, (manifest) => ({
      ...manifest,
      passes: manifest.passes.some((pass) => pass.id === 'live')
        ? manifest.passes
        : [...manifest.passes, { id: 'live', kind: 'live', createdAt: endedAt, model: MODEL_LABEL }]
    }))
  }

  const result: MeetingRecording = {
    pageId,
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
    if (getSettings().audioRetentionDays === 0) await deleteSessionAudio(pageId)
    if (conversation) notifyLabeled(pageId)
  }
  for (const listener of listeners) listener(result)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recorder:finished', result)
  return result
}

/**
 * Rewrites WAV headers that disagree with their file's length (a recording cut off by a crash or
 * power loss) and updates those sessions' track lengths. Run once at startup.
 */
export async function repairInterruptedAudio(): Promise<void> {
  const { repaired, ...counts } = await repairSessionAudio(sessionsRoot(), (id) => id === active?.pageId)
  for (const id of repaired) {
    try {
      const lengths = await Promise.all(
        TRACKS.map(async (track) => [track, await dataBytes(trackPath(id, track))] as const)
      )
      await updateManifest(id, (manifest) => ({
        ...manifest,
        audio: 'kept',
        tracks: lengths.flatMap(([track, size]) =>
          existsSync(trackPath(id, track))
            ? [{ name: track, file: `${track}.wav`, sampleRate: SAMPLE_RATE, seconds: size / BYTES_PER_SECOND }]
            : []
        )
      }))
    } catch (error) {
      log('recorder', 'could not update a repaired session', { id, error: errorMessage(error) })
    }
  }
  if (repaired.length || counts.failed) {
    log('recorder', 'repaired interrupted audio', { sessions: repaired.length, ...counts })
  }
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
  await stop(QUIT_TRANSCRIBE_MS)
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

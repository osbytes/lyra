import { BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AudioTrack, MeetingRecording, TranscriptProgress } from '../shared/types'
import { getSettings } from './settings'
import {
  closeOpenMarks,
  liveSegmentOf,
  mergeLivePass,
  readLiveFile,
  writeLiveFile,
  type LiveSegment,
  type Untranscribed
} from './livePass'
import { log } from './log'
import { notifyLabeled } from './meeting/events'
import { clearOwed, owe } from './pendingWork'
import { resolveInNotes } from './pages'
import { sessionAudioDir, sessionRawDir, sessionsRoot, updateManifest, type TrackInfo } from './sessionStore'
import { TakeWriter } from './takeWriter'
import { ChunkedTranscriber, type Transcribe } from './transcriber'
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
import { MODEL_LABEL, retryGpu, transcribePcm, whisperBackend } from './whisper'

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
/**
 * How often the words so far are saved to `raw/live.json` while recording, with a mark of the
 * audio not transcribed yet, so a crash loses only this much transcription (redone from the
 * audio at the next start) rather than the whole take's.
 */
const LIVE_CHECKPOINT_MS = 5000

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
  /** The next save of the words so far, if one is due. */
  checkpointTimer: ReturnType<typeof setTimeout> | null
  /** Saves of `live.json` in order, so a checkpoint never lands over the take's final save. */
  saving: Promise<void>
  /** A fixture's crash: words that come back after it go nowhere, as they would with the app gone. */
  dead: boolean
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

/** A take in progress, as its lines are written: what settling its speakers live needs. */
export type LiveTake = {
  pageId: string
  /** Where the take starts on the session timeline, in seconds. */
  offset: number
  /** Audio recorded so far, on the session timeline. */
  seconds: number
  micPath: string
  systemPath: string | null
  writer: TakeWriter
}
const chunkListeners = new Set<(take: LiveTake) => void>()

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
    // An earlier take a crash cut short ends where this one starts.
    const closed = existing.state === 'ok' ? closeOpenMarks(existing.file, offset) : null
    if (closed) await writeLiveFile(sessionRawDir(pageId), closed)
    // Normally loaded by the window's warm-up already; replays and evals start here.
    if (transcribeAudio) {
      await ensureSpeechVad()
      retryGpu()
    }
    const writer = new TakeWriter(pageId)
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
      checkpointTimer: null,
      saving: Promise.resolve(),
      dead: false,
      transcriber: new ChunkedTranscriber(
        [...tracks.keys()],
        aligned / 2,
        transcribeAudio ? experiment.transcribe : () => Promise.resolve([]),
        (chunk) => {
          if (recording.dead) return
          live.push(liveSegmentOf(chunk))
          writer.write(chunk)
          scheduleCheckpoint(recording)
          // Only while it's still being recorded: once stopped, the whole recording is settled.
          if (active === recording) for (const listener of chunkListeners) listener(liveTake(recording))
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
    // Owed from the start: a take a crash cuts short still has its speakers settled next launch,
    // and its audio transcribed, even if Whisper hadn't handed out a word yet.
    await owe(pageId, [
      ...(transcribeAudio ? (['transcribe'] as const) : []),
      ...(identifySpeakers ? (['speakers'] as const) : [])
    ])
    if (transcribeAudio) await saveCheckpoint(recording)
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

function liveTake(recording: Recording): LiveTake {
  const mic = recording.tracks.get('mic')
  return {
    pageId: recording.pageId,
    offset: recording.offset,
    seconds: (mic?.bytes ?? 0) / BYTES_PER_SECOND,
    micPath: mic?.path ?? trackPath(recording.pageId, 'mic'),
    systemPath: recording.tracks.get('system')?.path ?? null,
    writer: recording.writer
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

function reportProgress(recording: Recording, progress: { queued: number; queuedSeconds: number }): void {
  if (progress.queued === recording.queued) return
  recording.queued = progress.queued
  const status: TranscriptProgress = {
    pageId: recording.pageId,
    queued: progress.queued,
    queuedSeconds: progress.queuedSeconds,
    backend: whisperBackend()
  }
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
 * Merges this take's words so far into `raw/live.json`, with markers for the audio of the take
 * not transcribed yet. Saving again replaces both, so the take can be saved while recording,
 * before Whisper is done, and after. Saves run one at a time. True when the take has words.
 */
function saveLivePass(
  recording: Recording,
  untranscribed: readonly Omit<Untranscribed, 'take'>[]
): Promise<boolean> {
  const save = recording.saving.then(async () => {
    if (!recording.live.length && !untranscribed.length && !recording.marked) return false
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
        untranscribed: untranscribed.map((span) => ({ take: recording.offset, ...span }))
      })
      await writeLiveFile(dir, pass)
      recording.marked = untranscribed.length > 0
    } catch (error) {
      log('recorder', 'could not save the live words', { pageId: recording.pageId, error: errorMessage(error) })
    }
    return recording.live.length > 0
  })
  recording.saving = save.then(() => undefined)
  return save
}

/** Lists the live pass in the manifest, once the session has one. */
async function listLivePass(pageId: string, createdAt: string): Promise<void> {
  await updateManifest(pageId, (manifest) => ({
    ...manifest,
    passes: manifest.passes.some((pass) => pass.id === 'live')
      ? manifest.passes
      : [...manifest.passes, { id: 'live', kind: 'live', createdAt, model: MODEL_LABEL }]
  }))
}

/**
 * Saves the words so far, marking everything after them as not transcribed, open-ended: if the
 * app dies before the next save, the next start transcribes the take from there to the end of
 * its audio (`resume.ts`).
 */
async function saveCheckpoint(recording: Recording): Promise<void> {
  const marks = recording.transcriber
    .handedOut()
    .map(({ track, at }) => ({ track, start: at, end: at, open: true }))
  const hasLive = await saveLivePass(recording, marks)
  if (hasLive) await listLivePass(recording.pageId, new Date().toISOString())
}

/** A checkpoint a few seconds after a chunk lands, so a burst of chunks is one save. */
function scheduleCheckpoint(recording: Recording): void {
  if (recording.checkpointTimer || active !== recording) return
  recording.checkpointTimer = setTimeout(() => {
    recording.checkpointTimer = null
    if (active === recording) void saveCheckpoint(recording)
  }, LIVE_CHECKPOINT_MS)
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
  if (recording.checkpointTimer) clearTimeout(recording.checkpointTimer)
  recording.checkpointTimer = null
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
    // The markers in live.json say what is missing; the next start transcribes it (`resume.ts`).
    log('recorder', 'stopped before the transcription caught up', {
      pageId,
      untranscribed: unfinished.map((span) => ({ ...span, seconds: +(span.end - span.start).toFixed(1) }))
    })
  }
  const conversation = await recording.writer.end()
  hasLive = (await saveLivePass(recording, unfinished)) || hasLive
  if (hasLive) await listLivePass(pageId, endedAt)
  // All of it transcribed: nothing for the next start to pick up, even if this stop is the quit's.
  if (!unfinished.length) await clearOwed(pageId, 'transcribe')

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
    if (conversation) {
      await owe(pageId, ['notes'])
      notifyLabeled(pageId)
    }
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

/** Called with the take each time more of it has been transcribed, while it is being recorded. */
export function onLiveChunk(listener: (take: LiveTake) => void): () => void {
  chunkListeners.add(listener)
  return () => chunkListeners.delete(listener)
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
  /**
   * Resolves once the audio appended so far is transcribed. A replay hands audio over far faster
   * than it was spoken; waiting here keeps the order of a real recording, where the words and the
   * speakers of a stretch are in before much more has been said.
   */
  caughtUp: async (): Promise<void> => {
    await active?.transcriber.settled()
  },
  stop,
  /**
   * The app dying mid-recording, as far as one process can play it: the audio reaches the disk
   * with its header as last patched, the words saved so far stay as they are, and nothing is
   * finished, saved or announced. Resolves once the dead take's Whisper calls are done, so they
   * don't run alongside whatever comes next.
   */
  crash: async (): Promise<void> => {
    const recording = active
    if (!recording) return
    active = null
    recording.dead = true
    clearInterval(recording.headerTimer)
    if (recording.checkpointTimer) clearTimeout(recording.checkpointTimer)
    await recording.headerPatch
    await recording.saving
    for (const file of recording.tracks.values()) {
      file.stream.end()
      await finished(file.stream).catch(() => undefined)
    }
    await recording.transcriber.settled()
    log('recorder', 'crashed (fixture)', { pageId: recording.pageId })
  }
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

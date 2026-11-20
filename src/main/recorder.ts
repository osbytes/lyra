import { BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AudioTrack, MeetingRecording } from '../shared/types'
import { log } from './log'
import { notesDir, resolveInNotes } from './pages'

/**
 * Writes a meeting's audio to disk as it is captured: one 16 kHz mono 16-bit WAV
 * per track (mic, system), in `<notes>/.audio/`. The header is patched with the
 * final length when recording stops.
 */

const SAMPLE_RATE = 16000
const HEADER_BYTES = 44
const TRACKS: readonly AudioTrack[] = ['mic', 'system']

type TrackFile = { path: string; stream: WriteStream; bytes: number }
type Recording = { pageId: string; tracks: Map<AudioTrack, TrackFile> }

let active: Recording | null = null
const listeners = new Set<(recording: MeetingRecording) => void>()

export function audioDir(): string {
  return join(notesDir(), '.audio')
}

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
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

function stemOf(pageId: string): string {
  return pageId.replace(/\.(txt|md)$/i, '')
}

export function trackPath(pageId: string, track: AudioTrack): string {
  return join(audioDir(), `${stemOf(pageId)}.${track}.wav`)
}

function openTrack(pageId: string, track: AudioTrack): TrackFile {
  const path = trackPath(pageId, track)
  const stream = createWriteStream(path)
  stream.write(wavHeader(0))
  return { path, stream, bytes: 0 }
}

async function start(pageId: string, withSystem: boolean): Promise<void> {
  resolveInNotes(pageId)
  if (active) await stop()
  await mkdir(audioDir(), { recursive: true })
  const tracks = new Map<AudioTrack, TrackFile>([['mic', openTrack(pageId, 'mic')]])
  if (withSystem) tracks.set('system', openTrack(pageId, 'system'))
  active = { pageId, tracks }
  log('recorder', 'started', { pageId, tracks: [...tracks.keys()] })
}

function append(track: AudioTrack, payload: unknown): void {
  const file = active?.tracks.get(track)
  if (!file) return
  if (!ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) return
  const bytes = ArrayBuffer.isView(payload)
    ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    : Buffer.from(payload)
  if (bytes.byteLength % 2 !== 0) return
  file.stream.write(bytes)
  file.bytes += bytes.byteLength
}

async function finalize(file: TrackFile): Promise<number> {
  file.stream.end()
  await finished(file.stream)
  const handle = await open(file.path, 'r+')
  try {
    await handle.write(wavHeader(file.bytes), 0, HEADER_BYTES, 0)
  } finally {
    await handle.close()
  }
  return file.bytes / 2 / SAMPLE_RATE
}

async function stop(): Promise<MeetingRecording | null> {
  const recording = active
  if (!recording) return null
  active = null
  const mic = recording.tracks.get('mic')
  const system = recording.tracks.get('system')
  const seconds = mic ? await finalize(mic) : 0
  if (system) await finalize(system)
  const result: MeetingRecording = {
    pageId: recording.pageId,
    micPath: mic?.path ?? '',
    systemPath: system?.path ?? null,
    seconds
  }
  log('recorder', 'stopped', { pageId: result.pageId, seconds: +seconds.toFixed(1) })
  for (const listener of listeners) listener(result)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recorder:finished', result)
  return result
}

/** Called with each finished meeting recording (the speaker pipeline hooks in here). */
export function onRecordingFinished(listener: (recording: MeetingRecording) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function registerRecorderIpc(): void {
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

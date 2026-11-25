import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioTrack, RetentionPreview } from '../shared/types'
import { audioExpired, retentionCutoff } from '../shared/retention'
import { log } from './log'
import { notesDir } from './pages'
import { deleteSessionAudio, recordingPageId, trackPath } from './recorder'
import { peekManifest, sessionIds } from './sessionStore'
import { getSettings, onSettingsChanged } from './settings'

/**
 * Deletes recorded audio older than the "Keep recordings" setting. Transcripts, raw passes and
 * notes are never touched; a session's manifest records that its audio is gone.
 */

const DAY_MS = 86_400_000
const SWEEP_EVERY_MS = DAY_MS
const TRACKS: readonly AudioTrack[] = ['mic', 'system']

/** Tracks Lyra 0.2 kept in `<notes>/.audio/`, for notes not yet migrated to sessions. */
async function expiredLegacyAudio(cutoff: number): Promise<{ path: string; bytes: number }[]> {
  const dir = join(notesDir(), '.audio')
  const expired: { path: string; bytes: number }[] = []
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.toLowerCase().endsWith('.wav')) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info && info.mtimeMs < cutoff) expired.push({ path, bytes: info.size })
  }
  return expired
}

/** Sessions whose kept audio ended before `cutoff`, never the one being recorded. */
async function expiredSessions(cutoff: number): Promise<string[]> {
  const expired: string[] = []
  for (const id of await sessionIds()) {
    if (id === recordingPageId()) continue
    const manifest = peekManifest(id)
    if (manifest?.audio !== 'kept') continue
    if (audioExpired(manifest.endedAt ?? manifest.updatedAt, cutoff)) expired.push(id)
  }
  return expired
}

async function sessionAudioBytes(id: string): Promise<number> {
  let bytes = 0
  for (const track of TRACKS) {
    bytes += (await stat(trackPath(id, track)).catch(() => null))?.size ?? 0
  }
  return bytes
}

/**
 * What `days` would delete right now, without deleting it: for Settings to confirm before a
 * stricter value is saved (saving it sweeps at once). Counts the same audio `sweepAudio` would.
 */
export async function previewAudioSweep(days: number | null, now = Date.now()): Promise<RetentionPreview> {
  const cutoff = retentionCutoff(days, now)
  if (cutoff === null) return { sessions: 0, bytes: 0 }
  const ids = await expiredSessions(cutoff)
  const legacy = await expiredLegacyAudio(cutoff)
  let bytes = legacy.reduce((sum, file) => sum + file.bytes, 0)
  for (const id of ids) bytes += await sessionAudioBytes(id)
  return { sessions: ids.length + legacy.length, bytes }
}

/** Deletes expired audio; returns how many sessions (or legacy files) lost theirs. */
export async function sweepAudio(now = Date.now()): Promise<number> {
  const days = getSettings().audioRetentionDays
  // Forever keeps everything; 0 is handled as soon as a session is transcribed.
  const cutoff = retentionCutoff(days, now)
  if (cutoff === null) return 0
  let deleted = 0
  for (const id of await expiredSessions(cutoff)) {
    try {
      await deleteSessionAudio(id)
      deleted++
    } catch (error) {
      log('retention', 'could not delete expired audio', { id, error: String(error) })
    }
  }
  for (const { path } of await expiredLegacyAudio(cutoff)) {
    try {
      await unlink(path)
      deleted++
    } catch (error) {
      log('retention', 'could not delete expired audio', { error: String(error) })
    }
  }
  if (deleted) log('retention', 'deleted expired audio', { deleted, days })
  return deleted
}

let timer: ReturnType<typeof setInterval> | null = null

/** Sweeps now, once a day after, and whenever the setting or the notes folder changes. */
export function startAudioRetention(): void {
  const run = (): void => {
    sweepAudio().catch((error: unknown) => {
      log('retention', 'sweep failed', String(error))
    })
  }
  run()
  timer ??= setInterval(run, SWEEP_EVERY_MS)
  onSettingsChanged((next, prev) => {
    if (next.audioRetentionDays !== prev.audioRetentionDays || next.notesDir !== prev.notesDir) run()
  })
}

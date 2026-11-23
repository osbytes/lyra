import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'
import { notesDir } from './pages'
import { deleteSessionAudio, recordingPageId } from './recorder'
import { peekManifest, sessionIds } from './sessionStore'
import { getSettings, onSettingsChanged } from './settings'

/**
 * Deletes recorded audio older than the "Keep recordings" setting. Transcripts, raw passes and
 * notes are never touched; a session's manifest records that its audio is gone.
 */

const DAY_MS = 86_400_000
const SWEEP_EVERY_MS = DAY_MS

/** Tracks Lyra 0.2 kept in `<notes>/.audio/`, for notes not yet migrated to sessions. */
async function sweepLegacyAudio(cutoff: number): Promise<number> {
  const dir = join(notesDir(), '.audio')
  let deleted = 0
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.toLowerCase().endsWith('.wav')) continue
    const path = join(dir, name)
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue
      await unlink(path)
      deleted++
    } catch (error) {
      log('retention', 'could not delete expired audio', { name, error: String(error) })
    }
  }
  return deleted
}

/** Deletes expired audio; returns how many sessions (or legacy files) lost theirs. */
export async function sweepAudio(now = Date.now()): Promise<number> {
  const days = getSettings().audioRetentionDays
  // Forever keeps everything; 0 is handled as soon as a session is transcribed.
  if (days === null || days === 0) return 0
  const cutoff = now - days * DAY_MS
  let deleted = 0
  for (const id of await sessionIds()) {
    if (id === recordingPageId()) continue
    const manifest = peekManifest(id)
    if (manifest?.audio !== 'kept') continue
    const ended = Date.parse(manifest.endedAt ?? manifest.updatedAt)
    if (!Number.isFinite(ended) || ended >= cutoff) continue
    try {
      await deleteSessionAudio(id)
      deleted++
    } catch (error) {
      log('retention', 'could not delete expired audio', { id, error: String(error) })
    }
  }
  deleted += await sweepLegacyAudio(cutoff)
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

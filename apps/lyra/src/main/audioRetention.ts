import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'
import { audioDir } from './recorder'
import { getSettings, onSettingsChanged } from './settings'

/**
 * Deletes recorded audio older than the "Keep recordings" setting. Transcripts and notes are
 * never touched; only `.wav` tracks in the audio folder are.
 */

const DAY_MS = 86_400_000
const SWEEP_EVERY_MS = DAY_MS

/** Deletes expired tracks; returns how many. `now` is injectable for checks. */
export async function sweepAudio(now = Date.now()): Promise<number> {
  const days = getSettings().audioRetentionDays
  // Forever keeps everything; 0 is handled when a meeting finishes labeling.
  if (days === null || days === 0) return 0
  const cutoff = now - days * DAY_MS
  const dir = audioDir()
  const names = await readdir(dir).catch(() => [])
  let deleted = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.wav')) continue
    const path = join(dir, name)
    try {
      // mtime is the end of recording: the file is written until the session stops.
      if ((await stat(path)).mtimeMs >= cutoff) continue
      await unlink(path)
      deleted++
    } catch (error) {
      log('retention', 'could not delete expired audio', { name, error: String(error) })
    }
  }
  if (deleted) log('retention', 'deleted expired audio', { deleted, days })
  return deleted
}

let timer: ReturnType<typeof setInterval> | null = null

/** Sweeps now, once a day after, and whenever the setting gets shorter. */
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

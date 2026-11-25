import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import type { PassInfo, TrackInfo } from './sessionManifest'

/**
 * Rebuilding a session's manifest from what is in its folder, when `session.json` is missing or
 * unreadable but the audio and model passes are still there. Pure (no Electron) for tests.
 */

const SAMPLE_RATE = 16000
const WAV_HEADER_BYTES = 44
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const PLAIN_NAME = /^(?!\.+$)[\w.-]+$/

const PassHead = z.object({
  kind: z.enum(['live', 'diarized']).optional(),
  model: z.string().optional(),
  createdAt: z.string().optional()
})

/** The recordings in `audio/`: `mic.wav` and `system.wav`, as the recorder names them. */
export async function tracksOnDisk(audioDir: string): Promise<TrackInfo[]> {
  const tracks: TrackInfo[] = []
  for (const name of ['mic', 'system'] as const) {
    const file = `${name}.wav`
    try {
      const { size } = await stat(join(audioDir, file))
      tracks.push({
        name,
        file,
        sampleRate: SAMPLE_RATE,
        seconds: Math.max(0, size - WAV_HEADER_BYTES) / BYTES_PER_SECOND
      })
    } catch {
      // Not recorded, or deleted by retention.
    }
  }
  return tracks
}

/** The model passes in `raw/`, oldest first, read leniently: a pass's file is what matters. */
export async function passesOnDisk(rawDir: string): Promise<PassInfo[]> {
  const names = await readdir(rawDir).catch(() => [])
  const passes: PassInfo[] = []
  for (const name of names) {
    if (extname(name) !== '.json') continue
    const id = basename(name, '.json')
    if (!PLAIN_NAME.test(id)) continue
    const path = join(rawDir, name)
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const parsed = PassHead.safeParse(JSON.parse(text))
      const head = parsed.success ? parsed.data : {}
      passes.push({
        id,
        kind: head.kind ?? (id === 'live' ? 'live' : 'diarized'),
        model: head.model ?? 'unknown',
        createdAt: head.createdAt ?? info.mtime.toISOString()
      })
    } catch {
      // Unreadable pass: leave it out of the manifest, but on disk as it is.
    }
  }
  return passes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

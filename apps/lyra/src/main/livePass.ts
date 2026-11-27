import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AudioTrack } from '../shared/types'
import type { TranscribedChunk } from './transcriber'

/**
 * `raw/live.json`: every word transcribed while recording, across all of a session's takes. Each
 * take merges its words in. It is the only copy of what Whisper heard live, so it is parsed
 * strictly, written atomically, never merged over when unreadable, and fields this version
 * doesn't know (a legacy `text`, anything newer) are carried through untouched.
 */

const Word = z.object({ text: z.string(), start: z.number(), end: z.number() })

export const LiveSegment = z.looseObject({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  track: z.enum(['mic', 'system', 'mix']),
  cluster: z.string().nullable(),
  confidence: z.number().nullable(),
  words: z.array(Word)
})
export type LiveSegment = z.infer<typeof LiveSegment>

/**
 * Audio of a take that was recorded but not transcribed, because the app quit or crashed before
 * Whisper caught up; the next start transcribes it (`resume.ts`). Seconds on the session
 * timeline; `take` is where that take starts, so the take's own later saves replace its marker.
 * `open`: saved while recording, before the end was known, so it runs to the end of the take's
 * audio, whatever `end` says.
 */
export const Untranscribed = z.object({
  take: z.number(),
  track: z.enum(['mic', 'system']),
  start: z.number(),
  end: z.number(),
  open: z.boolean().optional()
})
export type Untranscribed = z.infer<typeof Untranscribed>

/** Segments are kept as they are on disk; each is checked only where it is used. */
export const LiveFile = z.looseObject({
  segments: z.array(z.unknown()),
  untranscribed: z.array(Untranscribed).optional()
})
export type LiveFile = z.infer<typeof LiveFile>

const WithId = z.looseObject({ id: z.string() })

export const LIVE_FILE = 'live.json'

/** The parsed file, or null when it isn't JSON or isn't a live pass. */
export function parseLiveFile(text: string): LiveFile | null {
  try {
    const parsed = LiveFile.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The segments of a file that are well-formed, for code that reads them. */
export function liveSegments(file: LiveFile | null): LiveSegment[] {
  return (file?.segments ?? []).flatMap((entry) => {
    const segment = LiveSegment.safeParse(entry)
    return segment.success ? [segment.data] : []
  })
}

export type LiveUpdate = {
  model: string
  createdAt: string
  /** Where the take starts on the session timeline, in seconds. */
  take: number
  /** The take's segments so far; saving again replaces them by id rather than adding twice. */
  segments: readonly LiveSegment[]
  /** The take's audio not transcribed yet (empty once it all was). */
  untranscribed: readonly Untranscribed[]
}

/** The file with this take's words and markers merged in, everything else kept. */
export function mergeLivePass(existing: LiveFile | null, update: LiveUpdate): Record<string, unknown> {
  const ids = new Set(update.segments.map((segment) => segment.id))
  const kept = (existing?.segments ?? []).filter((entry) => {
    const segment = WithId.safeParse(entry)
    return !segment.success || !ids.has(segment.data.id)
  })
  const untranscribed = [
    ...(existing?.untranscribed ?? []).filter((entry) => entry.take !== update.take),
    ...update.untranscribed
  ]
  const rest = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== 'untranscribed'))
  return {
    ...rest,
    id: 'live',
    kind: 'live',
    model: update.model,
    createdAt: update.createdAt,
    segments: [...kept, ...update.segments],
    clusters: Array.isArray(rest.clusters) ? rest.clusters : [],
    ...(untranscribed.length ? { untranscribed } : {})
  }
}

export type LiveRead =
  | { state: 'missing' }
  | { state: 'ok'; file: LiveFile }
  /** Unreadable: moved aside to `aside` so the next save starts clean instead of losing it. */
  | { state: 'corrupt'; aside: string }

/** Reads `<dir>/live.json`, moving an unreadable one aside as `live.corrupt-<timestamp>.json`. */
export async function readLiveFile(dir: string, now = new Date()): Promise<LiveRead> {
  const path = join(dir, LIVE_FILE)
  if (!existsSync(path)) return { state: 'missing' }
  const file = parseLiveFile(await readFile(path, 'utf8'))
  if (file) return { state: 'ok', file }
  const aside = join(dir, `live.corrupt-${now.toISOString().replace(/[:.]/g, '-')}.json`)
  await rename(path, aside)
  return { state: 'corrupt', aside }
}

/** Writes `<dir>/live.json` through a temporary file, so a crash mid-write leaves the old one. */
export async function writeLiveFile(dir: string, pass: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, LIVE_FILE)
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify(pass), 'utf8')
  await rename(temp, path)
}

/** A transcribed chunk as kept in `raw/live.json`, labeled with the track it was heard on. */
export function liveSegmentOf(chunk: TranscribedChunk): LiveSegment {
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

/**
 * The file with its open markers closed at `end`: a new take starts there, so an earlier take a
 * crash cut short ends there too. Null when nothing was open.
 */
export function closeOpenMarks(file: LiveFile, end: number): LiveFile | null {
  const marks = file.untranscribed ?? []
  if (!marks.some((mark) => mark.open)) return null
  const closed = marks.map(({ open, ...mark }) =>
    open ? { ...mark, end: Math.max(mark.start, end) } : mark
  )
  return { ...file, untranscribed: closed }
}

/**
 * The spans to transcribe again, with open markers run to the end of their track's audio
 * (`seconds`); empty ones (all of it was transcribed after all) left out.
 */
export function marksToResume(
  marks: readonly Untranscribed[],
  seconds: (track: AudioTrack) => number
): Untranscribed[] {
  return marks.flatMap(({ open, ...mark }) => {
    const end = open ? seconds(mark.track) : Math.min(mark.end, seconds(mark.track))
    return end > mark.start ? [{ ...mark, end: +end.toFixed(3) }] : []
  })
}

/** Where each track was heard in the takes so far. */
export function heardSpans(file: LiveFile | null): { track: AudioTrack; start: number; end: number }[] {
  return liveSegments(file).flatMap((segment) =>
    segment.track === 'mix' ? [] : [{ track: segment.track, start: segment.start, end: segment.end }]
  )
}

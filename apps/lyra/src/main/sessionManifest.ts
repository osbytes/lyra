import { z } from 'zod'

/**
 * `session.json`, the manifest of one session (docs/SESSION-MODEL.md). Pure: no Electron, so the
 * parsing and recovery rules can be unit-tested.
 */

export const MANIFEST_VERSION = 1

/**
 * A file or pass name inside the session folder: `track.file` and `pass.id` become paths, so only
 * plain names pass (no separators, and not `.` or `..`).
 */
const FileName = z.string().regex(/^(?!\.+$)[\w.-]+$/)

const Iso = z.string()

const Track = z.object({
  name: z.enum(['mic', 'system']),
  file: FileName,
  sampleRate: z.number(),
  seconds: z.number()
})

const Pass = z.object({
  id: FileName,
  kind: z.enum(['live', 'diarized']),
  createdAt: Iso,
  model: z.string()
})

/**
 * A step a recording still owes its session, from when it is due until it is done: its audio
 * transcribed (the `untranscribed` marks in `raw/live.json` say which), speakers settled from the
 * whole recording, then its summary. Kept in the manifest so a quit or crash in between is picked
 * up at the next start (`resume.ts`), which then reads only the sessions that owe something.
 */
export const PendingWork = z.enum(['transcribe', 'speakers', 'notes'])
export type PendingWork = z.infer<typeof PendingWork>

export const ManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  id: z.string(),
  startedAt: Iso,
  endedAt: Iso.nullable(),
  updatedAt: Iso,
  tracks: z.array(Track),
  passes: z.array(Pass),
  audio: z.enum(['none', 'kept', 'deleted']),
  /** Cached for the list view, so it never has to load documents. */
  title: z.string(),
  /** The title is Lyra's (the start time, or an AI suggestion), not one the user typed. */
  titleAuto: z.boolean(),
  preview: z.string(),
  tags: z.array(z.string()),
  /** Distinct speakers in the transcript; 0 without one. */
  speakers: z.number(),
  /** sha256 of the export as last written, to spot edits made outside Lyra. */
  exportHash: z.string().nullable(),
  /** The document changed since the last export (e.g. Lyra quit mid-debounce). */
  dirty: z.boolean(),
  pending: z.array(PendingWork)
})
export type Manifest = z.infer<typeof ManifestSchema>
export type TrackInfo = Manifest['tracks'][number]
export type PassInfo = Manifest['passes'][number]

export type ParsedManifest =
  | {
      kind: 'ok'
      manifest: Manifest
      /**
       * The object as it was on disk. Written back under the known fields, so fields and a
       * `version` from a newer Lyra (sharing a synced folder) survive this one rewriting it.
       */
      raw: Record<string, unknown>
      /** Written by a newer Lyra than this one. */
      newer: boolean
      /** The file named another session (a folder copied by hand); the id was corrected. */
      idMismatch: boolean
    }
  | { kind: 'invalid'; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Entries that don't match are dropped, so one bad track never loses the others. */
function items<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function field<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

/**
 * Reads a manifest field by field: a malformed field falls back to a default instead of the
 * whole session being treated as unreadable. `invalid` only when it isn't a manifest at all.
 */
export function parseManifest(input: unknown, id: string, now: string): ParsedManifest {
  if (!isRecord(input)) return { kind: 'invalid', reason: 'not an object' }
  const { version } = input
  if (typeof version !== 'number' || !Number.isInteger(version) || version < MANIFEST_VERSION) {
    return { kind: 'invalid', reason: 'unknown version' }
  }
  const title = typeof input.title === 'string' ? input.title : null
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    id,
    startedAt: field(Iso, input.startedAt, now),
    endedAt: field(Iso.nullable(), input.endedAt, null),
    updatedAt: field(Iso, input.updatedAt, now),
    tracks: items(Track, input.tracks),
    passes: items(Pass, input.passes),
    audio: field(ManifestSchema.shape.audio, input.audio, 'none'),
    title: title ?? 'Untitled',
    // Sessions from before this flag keep their title, unless they never had one.
    titleAuto: field(z.boolean(), input.titleAuto, title === null || title === 'Untitled'),
    preview: field(z.string(), input.preview, ''),
    tags: items(z.string(), input.tags),
    speakers: field(z.number(), input.speakers, 0),
    exportHash: field(z.string().nullable(), input.exportHash, null),
    dirty: input.dirty === true,
    pending: [...new Set(items(PendingWork, input.pending))]
  }
  return {
    kind: 'ok',
    manifest,
    raw: input,
    newer: version > MANIFEST_VERSION,
    idMismatch: input.id !== id
  }
}

/**
 * What goes on disk: the known fields over whatever else the file held, keeping a newer
 * version number so this build never downgrades a file it only partly understands.
 */
export function manifestForDisk(
  manifest: Manifest,
  raw: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!raw) return manifest
  const version = typeof raw.version === 'number' && raw.version > manifest.version ? raw.version : manifest.version
  return { ...raw, ...manifest, version }
}

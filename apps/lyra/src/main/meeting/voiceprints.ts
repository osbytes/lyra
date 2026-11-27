import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readManifestOf, readSession, sessionRawDir, type RawPass } from '../sessionStore'
import {
  ownedVoiceprints,
  withLiveVoiceprints,
  type PassVoiceprints,
  type SessionVoiceprint
} from './speakerRules'

/** A raw pass as written now: each speaker's voiceprint records the model that made it. */
export type WrittenPass = Omit<RawPass, 'clusters'> & {
  clusters: (RawPass['clusters'][number] & { model: string })[]
}

const PassFile = z.object({
  segments: z.array(z.unknown()).catch([]),
  clusters: z.array(z.unknown()).catch([])
})
const Segment = z.object({ id: z.string(), cluster: z.string().nullable() })
const Cluster = z.object({ id: z.string(), embedding: z.array(z.number()), model: z.string().optional() })

/** A pass's segments and voiceprints; entries that aren't one are skipped. */
function readPass(parsed: unknown): PassVoiceprints {
  const pass = PassFile.safeParse(parsed)
  if (!pass.success) return { segments: [], clusters: [] }
  return {
    segments: pass.data.segments.flatMap((entry) => {
      const segment = Segment.safeParse(entry)
      return segment.success ? [segment.data] : []
    }),
    clusters: pass.data.clusters.flatMap((entry) => {
      const cluster = Cluster.safeParse(entry)
      return cluster.success ? [cluster.data] : []
    })
  }
}

/** A session's raw passes, newest first; a missing or unreadable one is skipped. */
async function readPasses(pageId: string): Promise<PassVoiceprints[]> {
  const manifest = await readManifestOf(pageId)
  const out: PassVoiceprints[] = []
  for (const pass of [...manifest.passes].reverse()) {
    try {
      out.push(readPass(JSON.parse(await readFile(join(sessionRawDir(pageId), `${pass.id}.json`), 'utf8'))))
    } catch {
      // A missing or unreadable pass: try the one before.
    }
  }
  return out
}

/** Each session's speakers as the latest live round heard them; gone once a pass is written. */
const heardLive = new Map<string, Map<string, SessionVoiceprint>>()

/** Keeps what a live round heard, so a speaker named while recording can be saved as a voice. */
export function setLiveVoiceprints(pageId: string, prints: Map<string, SessionVoiceprint>): void {
  heardLive.set(pageId, prints)
}

/** A pass now holds the session's voiceprints; the live ones would only shadow it. */
export function clearLiveVoiceprints(pageId: string): void {
  heardLive.delete(pageId)
}

/**
 * The voiceprint of each speaker who still owns lines of the transcript (`ownedVoiceprints`), or,
 * while recording, as the latest live round heard them (`withLiveVoiceprints`).
 */
export async function sessionVoiceprints(pageId: string): Promise<Map<string, SessionVoiceprint>> {
  const [passes, session] = await Promise.all([readPasses(pageId), readSession(pageId)])
  const owned = ownedVoiceprints(passes, session.transcript)
  const live = heardLive.get(pageId)
  return live ? withLiveVoiceprints(owned, live, session.transcript) : owned
}

/** The speaker each pass gave each of its segments, by segment id (unique across passes). */
export async function passClusters(pageId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const pass of await readPasses(pageId)) {
    for (const segment of pass.segments) if (!out.has(segment.id)) out.set(segment.id, segment.cluster)
  }
  return out
}

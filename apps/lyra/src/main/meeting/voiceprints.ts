import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readManifestOf, sessionRawDir } from '../sessionStore'

const PassClusters = z.object({ clusters: z.array(z.unknown()) })
const Cluster = z.object({ id: z.string(), embedding: z.array(z.number()) })

/** A pass's speaker voiceprints; entries that aren't one are skipped. */
function readClusters(parsed: unknown): z.infer<typeof Cluster>[] {
  const pass = PassClusters.safeParse(parsed)
  if (!pass.success) return []
  return pass.data.clusters.flatMap((entry) => {
    const cluster = Cluster.safeParse(entry)
    return cluster.success ? [cluster.data] : []
  })
}

/** Every speaker voiceprint a session has, from its newest pass back. */
export async function sessionVoiceprints(pageId: string): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>()
  const manifest = await readManifestOf(pageId)
  for (const pass of [...manifest.passes].reverse()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sessionRawDir(pageId), `${pass.id}.json`), 'utf8'))
      for (const cluster of readClusters(parsed)) {
        if (!found.has(cluster.id) && cluster.embedding.length) found.set(cluster.id, cluster.embedding)
      }
    } catch {
      // A missing or unreadable pass: try the one before.
    }
  }
  return found
}

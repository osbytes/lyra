import { z } from 'zod'

/** Longest app name kept; real ones (exe, package or bundle names) are far shorter. */
const MAX_NAME = 100
/** Most names kept, so a stray file can't grow settings.json without bound. */
const MAX_APPS = 500

const AppName = z.string().trim().min(1).max(MAX_NAME)

/**
 * The "Don't ask" list as a file, for moving it between computers. A bare array of names is
 * accepted too, so a hand-written list imports.
 */
export const IgnoredAppsFile = z.union([
  z.object({
    lyra: z.literal('ignored-apps'),
    version: z.literal(1),
    apps: z.array(z.string())
  }),
  z.array(z.string())
])
export type IgnoredAppsFile = z.infer<typeof IgnoredAppsFile>

export function ignoredAppsFile(apps: readonly string[]): IgnoredAppsFile {
  return { lyra: 'ignored-apps', version: 1, apps: [...apps] }
}

/** The names in a parsed file. */
export function appsInFile(file: IgnoredAppsFile): string[] {
  return Array.isArray(file) ? file : file.apps
}

/**
 * `incoming` added to `existing`: trimmed, blank or overlong names dropped, and names matched
 * without case (the prompt compares them that way), keeping the existing spelling.
 */
export function mergeIgnoredApps(
  existing: readonly string[],
  incoming: readonly string[]
): { apps: string[]; added: number } {
  const apps = [...existing]
  const seen = new Set(existing.map((name) => name.toLowerCase()))
  let added = 0
  for (const raw of incoming) {
    const name = AppName.safeParse(raw)
    if (!name.success || seen.has(name.data.toLowerCase())) continue
    if (apps.length >= MAX_APPS) break
    seen.add(name.data.toLowerCase())
    apps.push(name.data)
    added++
  }
  return { apps, added }
}

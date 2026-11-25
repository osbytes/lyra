/**
 * What the mic watcher's helpers print, parsed. Pure (no Electron), so the unit tests and the
 * smoke test can check it.
 */

/** Apps currently using the microphone; `UNKNOWN_APP` when the platform can't say which. */
export type MicUsers = Set<string>
export const UNKNOWN_APP = ''

/**
 * Who is on the mic, and who is playing sound right now. `playing` is empty where the platform
 * can't say (the registry fallback, Linux, macOS before 14).
 */
export type AudioUsers = { mic: MicUsers; playing: Set<string> }

/** Says whether a reported name is Lyra itself. */
export type OwnName = string | ((name: string) => boolean)

const APPS_PREFIX = 'apps:'
const PLAYING_PREFIX = ';out:'

function isOwn(name: string, own: OwnName): boolean {
  return typeof own === 'string' ? name.toLowerCase() === own.toLowerCase() : own(name)
}

/**
 * One line from a helper: `apps:<name>,…;out:<name>,…` (process names on Windows, bundle ids on
 * macOS; the playing part is optional), or `1`/`0` when the macOS helper can't name apps. Names
 * that are Lyra's own (`own`: its exe name, or a test such as `ownBundleId`) are dropped.
 */
export function parseHelperLine(line: string, own: OwnName = ''): AudioUsers {
  const trimmed = line.trim()
  if (!trimmed.startsWith(APPS_PREFIX)) {
    return { mic: trimmed === '1' ? new Set([UNKNOWN_APP]) : new Set(), playing: new Set() }
  }
  const body = trimmed.slice(APPS_PREFIX.length)
  const split = body.indexOf(PLAYING_PREFIX)
  const names = (list: string): Set<string> =>
    new Set(list.split(',').filter((name) => name !== '' && !isOwn(name, own)))
  return split < 0
    ? { mic: names(body), playing: new Set() }
    : { mic: names(body.slice(0, split)), playing: names(body.slice(split + PLAYING_PREFIX.length)) }
}

/**
 * Lyra's own bundle id and its helper processes' (`<id>.helper`, `<id>.helper.Renderer`, …): on
 * macOS the audio capture runs in a helper, so that is the id the helper reports for Lyra.
 */
export function ownBundleId(bundleId: string): (name: string) => boolean {
  const own = bundleId.toLowerCase()
  return (name) => {
    const lower = name.toLowerCase()
    return lower === own || lower.startsWith(`${own}.helper`)
  }
}

/** How many times a helper that has worked is restarted before the watcher falls back. */
export const HELPER_MAX_RESTARTS = 5
const HELPER_RESTART_BASE_MS = 2000

/** The wait before restart number `attempt` (from 0): doubling from 2 s, or null to give up. */
export function helperRestartDelay(attempt: number): number | null {
  return attempt < HELPER_MAX_RESTARTS ? HELPER_RESTART_BASE_MS * 2 ** attempt : null
}

/** `CFBundleIdentifier` from an Info.plist's XML, or null. */
export function bundleIdFromPlist(xml: string): string | null {
  return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]?.trim() ?? null
}

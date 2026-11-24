export type Platform = 'mac' | 'windows' | 'linux'

export type ReleaseAsset = {
  platform: Platform
  /** What the visitor sees, e.g. `.dmg` or `Installer (.exe)`. */
  format: string
  name: string
  url: string
  size: number
}

export type Release = {
  version: string | null
  pageUrl: string
  assets: ReleaseAsset[]
}

/** release.yml publishes installers to this repository. */
export const REPO = 'osbytes/lyra'
export const REPO_URL = `https://github.com/${REPO}`
export const RELEASES_PAGE = `${REPO_URL}/releases/latest`
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** Cache tag on that fetch; release.yml expires it through app/api/revalidate once it publishes. */
export const RELEASE_CACHE_TAG = 'latest-release'

/** Installer names from apps/lyra/electron-builder.yml, the recommended one first per platform. */
const FORMATS: readonly { suffix: string; platform: Platform; format: string }[] = [
  { suffix: '.dmg', platform: 'mac', format: '.dmg' },
  { suffix: '.zip', platform: 'mac', format: '.zip' },
  { suffix: '-setup.exe', platform: 'windows', format: 'Installer (.exe)' },
  { suffix: '.AppImage', platform: 'linux', format: 'AppImage' },
  { suffix: '.deb', platform: 'linux', format: '.deb' }
]

const FALLBACK: Release = { version: null, pageUrl: RELEASES_PAGE, assets: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const isGitHubUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('https://github.com/')

function parseAsset(value: unknown): ReleaseAsset | null {
  if (!isRecord(value)) return null
  const { name, browser_download_url: url, size } = value
  if (typeof name !== 'string' || !isGitHubUrl(url) || typeof size !== 'number') return null
  const match = FORMATS.find((format) => name.endsWith(format.suffix))
  return match ? { platform: match.platform, format: match.format, name, url, size } : null
}

const rank = (asset: ReleaseAsset): number => FORMATS.findIndex((f) => f.format === asset.format)

/** Narrows GitHub's `releases/latest` response to what the site shows; null if it isn't one. */
export function parseRelease(value: unknown): Release | null {
  if (!isRecord(value) || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) {
    return null
  }
  const raw: unknown[] = value.assets
  const assets = raw
    .map(parseAsset)
    .filter((asset): asset is ReleaseAsset => asset !== null)
    .sort((a, b) => rank(a) - rank(b))
  return {
    version: value.tag_name.replace(/^v/, ''),
    pageUrl: isGitHubUrl(value.html_url) ? value.html_url : RELEASES_PAGE,
    assets
  }
}

/**
 * The latest published release, fetched on the server and cached, so download links point straight
 * at the installers. Falls back to the releases page if GitHub can't be reached. The cache outlives
 * deployments, so a new release shows up when release.yml expires it, or within the hour.
 */
export async function getLatestRelease(): Promise<Release> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const response = await fetch(LATEST_API, {
      headers,
      next: { revalidate: 3600, tags: [RELEASE_CACHE_TAG] }
    })
    if (!response.ok) {
      console.warn(`releases: GitHub answered ${String(response.status)}; linking to the releases page`)
      return FALLBACK
    }
    const body: unknown = await response.json()
    return parseRelease(body) ?? FALLBACK
  } catch (error) {
    console.warn('releases: could not reach GitHub', error instanceof Error ? error.message : String(error))
    return FALLBACK
  }
}

export function formatSize(bytes: number): string {
  return `${String(Math.round(bytes / 1_000_000))} MB`
}

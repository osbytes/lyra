import { pathToFileURL } from 'node:url'

/**
 * Whether a URL is one of Lyra's own pages: the bundled renderer file, or the dev server in
 * development. Pure (no Electron), so the unit tests can check it. Permission handlers use it so
 * only the app's own windows on the app's own page get the microphone.
 */
export type AppPages = {
  /** Absolute path of the bundled `renderer/index.html`. */
  rendererFile: string
  /** `electron-vite dev`'s server, in development only. */
  devUrl: string | null
}

export function isAppPage(url: string, pages: AppPages): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') {
    // The hash (`#overlay`) and query are the page's own state, not a different page.
    const page = `file://${parsed.host}${parsed.pathname}`
    return page === pathToFileURL(pages.rendererFile).href
  }
  if (pages.devUrl === null) return false
  try {
    return parsed.origin === new URL(pages.devUrl).origin
  } catch {
    return false
  }
}

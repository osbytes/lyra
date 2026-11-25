import { PROVIDERS } from '../shared/ai'
import { formatBytes } from '../shared/bytes'
import { isLoopbackUrl, type Settings } from '../shared/settings'
import type { Diagnostics } from '../shared/types'

/**
 * The pure half of Settings → About: labels and the "Copy diagnostics" text. Only versions,
 * folders, sizes and which engine is chosen: never note content, names, keys, server addresses
 * or search queries, so the text is safe to paste into a public issue.
 */

/** `path` with the home folder written as `~`, so a pasted report doesn't carry the user's name. */
export function shortenHome(path: string, home: string, ignoreCase = process.platform === 'win32'): string {
  if (!home) return path
  const trimmed = home.replace(/[\\/]+$/, '')
  // Windows paths compare without case: `C:\Users\Ana` and `c:\users\ana` are one folder.
  const sameCase = (text: string): string => (ignoreCase ? text.toLowerCase() : text)
  if (sameCase(path) === sameCase(trimmed)) return '~'
  const head = path.slice(0, trimmed.length)
  const next = path.charAt(trimmed.length)
  if (sameCase(head) === sameCase(trimmed) && (next === '/' || next === '\\')) {
    return `~${path.slice(trimmed.length)}`
  }
  return path
}

/**
 * Which engine writes summaries and titles, without a key or an address: a server's address can
 * carry a user name or an internal host, so only whether it is on this computer is said.
 */
export function notesEngineLabel(settings: Settings): string {
  switch (settings.notesEngine) {
    case 'off':
      return 'Off'
    case 'local':
      return 'On this computer (built-in model)'
    case 'cloud': {
      const info = PROVIDERS[settings.cloudProvider]
      const model = settings.cloudModel ?? info.defaultModel ?? 'no model chosen'
      if (settings.cloudProvider !== 'openai-compatible') return `${info.label} (${model})`
      const url = settings.cloudBaseUrl
      const where = url === null ? 'no address' : isLoopbackUrl(url) ? 'on this computer' : 'on another computer'
      return `OpenAI-compatible server ${where} (${model})`
    }
  }
}

export function backendLabel(backend: Diagnostics['whisper']['backend']): string {
  switch (backend) {
    case 'gpu':
      return 'GPU'
    case 'cpu':
      return 'CPU'
    case null:
      return 'not used yet'
  }
}

/** The plain text "Copy diagnostics" puts on the clipboard. */
export function diagnosticsText(info: Omit<Diagnostics, 'text'>): string {
  const lines = [
    `Lyra ${info.version}`,
    `OS: ${info.os} (${info.arch})`,
    `Electron ${info.electron}, Chromium ${info.chrome}, Node ${info.node}`,
    `Transcription: ${info.whisper.model}, ${backendLabel(info.whisper.backend)}`,
    `Summaries: ${info.notesEngine}`,
    ...info.places.map(
      (place) =>
        `${place.label}: ${place.path} (${formatBytes(place.bytes)}${place.complete ? '' : '+, not fully counted'})`
    )
  ]
  return lines.join('\n')
}

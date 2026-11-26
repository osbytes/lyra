import { formatBytes } from '../../../shared/bytes'
import type { ModelStatus } from '../../../shared/types'

/** What Settings shows under a setting whose model downloads on first use. */
export type ModelLine = {
  text: string
  tone: 'busy' | 'ready' | 'error' | 'idle'
  /** The button beside the text: stop the download, try again, or start it now. */
  action: 'cancel' | 'retry' | 'download' | null
  /** How far along, 0 to 1, for the bar; null when there is nothing to measure. */
  progress: number | null
}

/** Download errors end with the full URL, which the log keeps; Settings shows the reason. */
const withoutUrl = (message: string): string => message.replace(/ (?:for|from) https?:\/\/\S+/g, '')

const fraction = (part: number, whole: number): number => (whole > 0 ? Math.min(1, part / whole) : 0)

export function modelLine(status: ModelStatus): ModelLine {
  switch (status.state) {
    case 'missing':
      return { text: 'Not downloaded yet', tone: 'idle', action: 'download', progress: null }
    case 'downloading': {
      const done = fraction(status.received, status.total)
      const size = status.total > 0 ? ` · ${formatBytes(status.received)} of ${formatBytes(status.total)}` : ''
      return { text: `Downloading ${String(Math.floor(done * 100))}%${size}`, tone: 'busy', action: 'cancel', progress: done }
    }
    case 'reading': {
      if (status.total === 0) return { text: 'Reading your sessions…', tone: 'busy', action: null, progress: null }
      const paused =
        status.pausedFor === 'recording' ? ' · paused while recording' : status.pausedFor === 'battery' ? ' · paused on battery' : ''
      return {
        text: `Reading your sessions ${String(status.done)}/${String(status.total)}${paused}`,
        tone: 'busy',
        action: null,
        progress: fraction(status.done, status.total)
      }
    }
    case 'ready':
      return { text: 'Ready', tone: 'ready', action: null, progress: null }
    case 'cancelled':
      return { text: 'Download cancelled', tone: 'idle', action: 'retry', progress: null }
    case 'error':
      return { text: `Couldn’t set it up: ${withoutUrl(status.message)}`, tone: 'error', action: 'retry', progress: null }
  }
}

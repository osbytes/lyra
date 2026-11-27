import { useSyncExternalStore } from 'react'
import { lineAt } from './timeline'
import { log } from './log'

/**
 * Session audio playback, one stream at a time across the window. A line's play button starts a
 * stream there that runs on to the end of the session: audio is fetched in short chunks just
 * ahead of the playhead (an hour of audio is too much to fetch at once), and `line` follows the
 * words being spoken. A sample (the speaker picker's) is a short clip with its own key.
 */
export type PlaybackState = {
  pageId: string
  /** What's playing: a line id while a session plays through, or a clip's key. */
  key: string | null
  /** Seconds into the session. */
  position: number
  /** Where this stream stops: the session's end, or a clip's. */
  end: number
  paused: boolean
}

type Timed = { id: string; start: number; end: number }

const SAMPLE_RATE = 16000
/** Seconds of audio per fetch. */
const CHUNK = 20
/** Fetch the next chunk once less than this much is queued. */
const AHEAD = 8

let state: PlaybackState | null = null
let stream: {
  request: number
  context: AudioContext
  origin: number
  sources: AudioBufferSourceNode[]
  timer: ReturnType<typeof setInterval>
} | null = null
let request = 0
const listeners = new Set<() => void>()

function emit(next: PlaybackState | null): void {
  state = next
  for (const listener of listeners) listener()
}

export function stopPlayback(): void {
  request++
  const current = stream
  stream = null
  if (current) {
    clearInterval(current.timer)
    for (const source of current.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already finished.
      }
    }
    void current.context.close()
  }
  if (state) emit(null)
}

export function pausePlayback(): void {
  if (!stream || !state || state.paused) return
  void stream.context.suspend()
  emit({ ...state, paused: true })
}

export function resumePlayback(): void {
  if (!stream || !state?.paused) return
  void stream.context.resume()
  emit({ ...state, paused: false })
}

function toBuffer(context: AudioContext, pcm: Int16Array): AudioBuffer {
  const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000
  return buffer
}

/**
 * Plays from `from` seconds to `end`, stopping anything playing. With `lines`, the key follows the
 * line being spoken (a session playing through); without, `key` names the clip. Resolves false
 * when the session's audio isn't kept any more.
 */
export async function play(options: {
  pageId: string
  from: number
  end: number
  key?: string
  lines?: readonly Timed[]
}): Promise<boolean> {
  stopPlayback()
  const mine = request
  const { pageId, end, lines } = options
  const from = Math.max(0, Math.min(options.from, end))
  const first = await window.api.sessionAudio(pageId, from, Math.min(end, from + CHUNK))
  if (mine !== request) return true
  if (!first.length) return false

  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  // Session time = context time - origin.
  const origin = context.currentTime + 0.05 - from
  let fetchedTo = Math.min(end, from + CHUNK)
  let queuedTo = from
  let fetching = false
  const sources: AudioBufferSourceNode[] = []
  const schedule = (pcm: Int16Array): void => {
    const source = context.createBufferSource()
    source.buffer = toBuffer(context, pcm)
    source.connect(context.destination)
    source.start(origin + queuedTo)
    queuedTo += source.buffer.duration
    sources.push(source)
  }
  schedule(first)

  const keyAt = (position: number): string | null => {
    if (!lines) return options.key ?? null
    // Between lines the last one spoken stays lit, so the highlight doesn't flicker in pauses.
    return lineAt(lines, position)?.id ?? lines.findLast((line) => line.start <= position)?.id ?? null
  }

  const tick = (): void => {
    if (mine !== request || !state) return
    const position = Math.min(end, context.currentTime - origin)
    if (position >= Math.min(end, queuedTo) - 0.02 && fetchedTo >= end) {
      stopPlayback()
      return
    }
    const key = keyAt(position)
    if (key !== state.key || Math.abs(position - state.position) >= 0.25) emit({ ...state, key, position })
    if (!fetching && fetchedTo < end && queuedTo - position < AHEAD) {
      fetching = true
      const start = fetchedTo
      fetchedTo = Math.min(end, start + CHUNK)
      window.api
        .sessionAudio(pageId, start, fetchedTo)
        .then((pcm) => {
          if (mine !== request) return
          // Audio that runs out early (not all of it kept) ends the stream at that point.
          if (pcm.length) schedule(pcm)
          else fetchedTo = end
        })
        .catch((error: unknown) => {
          log('playback', 'could not fetch audio', String(error))
          fetchedTo = end
        })
        .finally(() => {
          fetching = false
        })
    }
  }

  stream = { request: mine, context, origin, sources, timer: setInterval(tick, 100) }
  emit({ pageId, key: keyAt(from), position: from, end, paused: false })
  return true
}

export function usePlayback(): PlaybackState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}

/** The current playback, read outside React (an event handler). */
export function playbackState(): PlaybackState | null {
  return state
}

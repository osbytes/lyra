import type { MeetingStatus, TranscriptProgress, WhisperStatus } from '../../../shared/types'

/** The words for a session's processing status, naming the job that failed when one does. */
export function statusLabel(status: MeetingStatus): string {
  const pct = `${String(Math.round(status.progress * 100))}%`
  switch (status.state) {
    case 'downloading':
      return `Downloading ${status.message ?? 'speaker models'}… ${pct}`
    case 'diarizing':
      return 'Still processing audio: finding who spoke when…'
    case 'transcribing':
      return `Transcribing each speaker… ${pct}`
    case 'summarizing':
      return 'Writing the summary…'
    case 'error':
      return `${status.task === 'notes' ? 'Couldn’t write the summary' : 'Couldn’t label speakers'}: ${status.message ?? 'unknown error'}`
    case 'done':
      return status.task === 'notes' ? 'Summary written' : 'Speakers labeled'
  }
}

/** Whether the session is still being worked on (not finished and not failed). */
export function statusBusy(status: MeetingStatus): boolean {
  return status.state !== 'done' && status.state !== 'error'
}

/** Whether a summary is being written for the session right now. */
export function writingNotes(status: MeetingStatus | null): boolean {
  return status?.task === 'notes' && status.state !== 'done' && status.state !== 'error'
}

/** Seconds of queued speech after which the transcript counts as falling behind. */
export const BEHIND_SECONDS = 15

/**
 * A short note for when transcription is falling behind the recording, or null while it keeps
 * up. Says when Whisper is on the CPU, since that is the usual reason.
 */
export function behindLabel(progress: Pick<TranscriptProgress, 'queuedSeconds' | 'backend'>): string | null {
  if (progress.queuedSeconds < BEHIND_SECONDS) return null
  const cpu = progress.backend === 'cpu' ? ' (using the CPU)' : ''
  return `Transcribing… ${String(Math.round(progress.queuedSeconds))} s behind${cpu}`
}

/** Recorder phases, as the dock knows them (`DictationPhase` in hooks/useDictation). */
type Phase = 'idle' | 'starting' | 'listening' | 'finishing'

/**
 * Every word the dock's status slot can show. The slot is as wide as the longest, so moving
 * between them (Listening, then Transcribing…) never resizes the dock or moves its button.
 */
export const DOCK_LABELS = ['Warming up…', 'Listening', 'Transcribing…', 'Finishing…'] as const

/** The dock's status word for the recorder's phase; empty while idle. */
export function dockLabel(phase: Phase, transcribing: boolean): string {
  switch (phase) {
    case 'starting':
      return 'Warming up…'
    case 'listening':
      return transcribing ? 'Transcribing…' : 'Listening'
    case 'finishing':
      return 'Finishing…'
    case 'idle':
      // The mic button's tooltip says what it does.
      return ''
  }
}

/**
 * Background work for the toast stack (a model download, transcription falling behind, a session
 * being processed), kept out of the dock so its text never changes size. `progress` (0–1) draws a
 * bar; busy work without it gets a spinner.
 */
export type Activity = {
  text: string
  /** Secondary words beside the text: a percentage, or how long is left. */
  detail: string | null
  progress: number | null
  tone: 'busy' | 'done' | 'error'
}

const percent = (progress: number): string => `${String(Math.round(progress * 100))}%`

/**
 * The background work worth showing beside the dock: a model downloading (with its progress), or
 * transcription falling behind the recording. Null when there's nothing to say.
 */
export function dockActivity(status: WhisperStatus, behind: string | null): Activity | null {
  if (status.state === 'downloading') {
    const progress = status.total > 0 ? Math.min(1, status.received / status.total) : 0
    return {
      text: 'Downloading the speech model…',
      detail: percent(progress),
      progress,
      tone: 'busy'
    }
  }
  return behind === null ? null : { text: behind, detail: null, progress: null, tone: 'busy' }
}

/**
 * Roughly how long is left, in the words a person would use. Past the estimate it says "almost
 * done", and once well past it, owns up that this run is slower than usual.
 */
export function timeLeftLabel(remainingMs: number, expectedMs: number): string {
  if (remainingMs < -expectedMs / 2) return 'taking longer than usual'
  if (remainingMs <= 5_000) return 'almost done'
  const seconds = remainingMs / 1000
  if (seconds < 60) return `about ${String(Math.ceil(seconds / 5) * 5)} s left`
  return `about ${String(Math.ceil(seconds / 60))} min left`
}

/** A session's processing status as a toast; `now` (ms since epoch) times the estimate. */
export function processingActivity(status: MeetingStatus, now: number): Activity {
  switch (status.state) {
    case 'downloading':
      return {
        text: `Downloading ${status.message ?? 'speaker models'}…`,
        detail: percent(status.progress),
        progress: status.progress,
        tone: 'busy'
      }
    case 'diarizing': {
      const text = 'Finding who spoke when…'
      if (!status.estimate) return { text, detail: null, progress: null, tone: 'busy' }
      const { startedAt, expectedMs } = status.estimate
      const elapsed = Math.max(0, now - startedAt)
      return {
        text,
        detail: timeLeftLabel(expectedMs - elapsed, expectedMs),
        // Never full while still running: the estimate can be short.
        progress: Math.min(0.95, elapsed / Math.max(1, expectedMs)),
        tone: 'busy'
      }
    }
    case 'transcribing':
      return {
        text: 'Transcribing each speaker…',
        detail: percent(status.progress),
        progress: status.progress,
        tone: 'busy'
      }
    case 'summarizing':
      return { text: 'Writing the summary…', detail: null, progress: null, tone: 'busy' }
    case 'error':
      return { text: statusLabel(status), detail: null, progress: null, tone: 'error' }
    case 'done':
      return { text: statusLabel(status), detail: null, progress: null, tone: 'done' }
  }
}

/**
 * A placeholder name for a new speaker that no current speaker has, so naming it can't merge it
 * into someone else (equal names merge).
 */
export function unusedSpeakerName(names: Iterable<string>): string {
  const taken = new Set<string>()
  for (const name of names) taken.add(name.trim().toLowerCase())
  for (let n = 1; ; n++) {
    const candidate = `Speaker ${String(n)}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * What screen readers hear when the recorder changes phase, or null for no change. Only
 * changes: the timer and level meters update constantly and are never announced.
 */
export function phaseAnnouncement(previous: Phase, phase: Phase): string | null {
  if (previous === phase) return null
  switch (phase) {
    case 'starting':
      return 'Starting to record'
    case 'listening':
      return 'Recording'
    case 'finishing':
      return 'Recording stopped. Finishing the transcript'
    case 'idle':
      return previous === 'finishing' ? 'Transcript finished' : 'Recording stopped'
  }
}

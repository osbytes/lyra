import type { MeetingStatus, TranscriptProgress } from '../../../shared/types'

/** The words for a session's processing status, naming the job that failed when one does. */
export function statusLabel(status: MeetingStatus): string {
  const pct = `${String(Math.round(status.progress * 100))}%`
  switch (status.state) {
    case 'downloading':
      return `Downloading ${status.message ?? 'speaker models'}… ${pct}`
    case 'diarizing':
      return 'Finding who spoke when…'
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

/** Recorder phases, as the dock knows them (`DictationPhase` in hooks/useDictation). */
type Phase = 'idle' | 'starting' | 'listening' | 'finishing'

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

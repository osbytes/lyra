import { useEffect, useState } from 'react'
import type { MeetingStatus, NotesState } from '../../../shared/types'
import { log } from '../lib/log'

/**
 * Where a session's notes stand against the current notes pipeline, asked again when the
 * summary appears or goes, and after a notes run finishes. Null until main answers (or when it
 * can't), which reads as nothing to say.
 */
export function useNotesState(pageId: string, hasSummary: boolean, status: MeetingStatus | null): NotesState | null {
  const [state, setState] = useState<NotesState | null>(null)
  const finished = status?.task === 'notes' && status.state === 'done'
  useEffect(() => {
    let current = true
    window.api.notesState(pageId).then(
      (next) => {
        if (current) setState(next)
      },
      (error: unknown) => {
        log('notes', 'could not read the notes state', String(error))
        if (current) setState(null)
      }
    )
    return () => {
      current = false
    }
  }, [pageId, hasSummary, finished])
  return state
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMeetingStatus } from '../hooks/useMeetingStatus'
import { useNotesState } from '../hooks/useNotesState'
import { log } from '../lib/log'
import { writingNotes } from '../lib/status'
import { ConfirmDialog } from './ConfirmDialog'

type Props = {
  pageId: string
  hasSummary: boolean
  className: string
  icon?: ReactNode
}

/**
 * Write / Rewrite summary, shared by the transcript's bar and the details panel. A manual
 * rewrite replaces the summary and isn't undoable, so an edited summary is confirmed first.
 * While a summary is being written (from here or anywhere else) the button becomes Stop. A
 * summary an older version of Lyra wrote, untouched since, offers an update instead.
 */
export function SummaryButton({ pageId, hasSummary, className, icon }: Props) {
  const status = useMeetingStatus(pageId)
  // Covers the gap between the click and main's first status, so a double click can't start two.
  // It names the session that was clicked: the button is reused as the user moves between
  // sessions, and a run in one must not show as running in all of them.
  const [starting, setStarting] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const writing = starting === pageId || writingNotes(status)
  const outdated = useNotesState(pageId, hasSummary, status) === 'outdated'
  const otherJob = !!status && status.task !== 'notes' && status.state !== 'done' && status.state !== 'error'

  const write = (id: string): void => {
    setStarting(id)
    window.api
      .generateNotes(id)
      .catch(() => {
        // Shown through the meeting status line.
      })
      .finally(() => {
        if (mounted.current) setStarting((current) => (current === id ? null : current))
      })
  }

  const onWrite = async (): Promise<void> => {
    const id = pageId
    setStarting(id)
    let edited = false
    if (hasSummary) {
      try {
        edited = await window.api.summaryEdited(id)
      } catch (error) {
        // Unknown counts as edited: asking once too often beats losing the user's words.
        log('notes', 'could not check the summary', String(error))
        edited = true
      }
    }
    if (!mounted.current) return
    if (edited) {
      setStarting((current) => (current === id ? null : current))
      setAsking(id)
      return
    }
    write(id)
  }

  const onStop = (): void => {
    window.api.cancelNotes(pageId).catch((error: unknown) => {
      log('notes', 'could not stop the summary', String(error))
    })
  }

  return (
    <>
      {/* One button whose job changes, so keyboard focus stays put when writing starts. */}
      <button
        type="button"
        className={className}
        disabled={!writing && otherJob}
        title={
          !writing && outdated
            ? 'Written by an earlier version of Lyra. Updating rewrites it with sections and better action items.'
            : undefined
        }
        onClick={() => {
          if (writing) onStop()
          else void onWrite()
        }}
      >
        {icon}
        {writing ? 'Stop summary' : outdated ? 'Update summary' : hasSummary ? 'Rewrite summary' : 'Write summary'}
      </button>
      {asking === pageId ? (
        <ConfirmDialog
          title="Replace your edited summary?"
          confirm="Replace summary"
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null)
            write(pageId)
          }}
        >
          You changed this summary since Lyra wrote it. Rewriting it replaces your changes, and
          this can’t be undone.
        </ConfirmDialog>
      ) : null}
    </>
  )
}

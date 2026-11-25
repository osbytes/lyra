import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMeetingStatus } from '../hooks/useMeetingStatus'
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
 * While a summary is being written (from here or anywhere else) the button becomes Stop.
 */
export function SummaryButton({ pageId, hasSummary, className, icon }: Props) {
  const status = useMeetingStatus(pageId)
  // Covers the gap between the click and main's first status, so a double click can't start two.
  const [starting, setStarting] = useState(false)
  const [asking, setAsking] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const writing = starting || writingNotes(status)
  const otherJob = !!status && status.task !== 'notes' && status.state !== 'done' && status.state !== 'error'

  const write = (): void => {
    setStarting(true)
    window.api
      .generateNotes(pageId)
      .catch(() => {
        // Shown through the meeting status line.
      })
      .finally(() => {
        if (mounted.current) setStarting(false)
      })
  }

  const onWrite = async (): Promise<void> => {
    setStarting(true)
    let edited = false
    if (hasSummary) {
      try {
        edited = await window.api.summaryEdited(pageId)
      } catch (error) {
        // Unknown counts as edited: asking once too often beats losing the user's words.
        log('notes', 'could not check the summary', String(error))
        edited = true
      }
    }
    if (!mounted.current) return
    if (edited) {
      setStarting(false)
      setAsking(true)
      return
    }
    write()
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
        onClick={() => {
          if (writing) onStop()
          else void onWrite()
        }}
      >
        {icon}
        {writing ? 'Stop summary' : hasSummary ? 'Rewrite summary' : 'Write summary'}
      </button>
      {asking ? (
        <ConfirmDialog
          title="Replace your edited summary?"
          confirm="Replace summary"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            write()
          }}
        >
          You changed this summary since Lyra wrote it. Rewriting it replaces your changes, and
          this can’t be undone.
        </ConfirmDialog>
      ) : null}
    </>
  )
}

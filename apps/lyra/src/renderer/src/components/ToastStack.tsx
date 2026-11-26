import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'
import { dismissMeetingStatus, useMeetingStatus } from '../hooks/useMeetingStatus'
import { processingActivity, type Activity } from '../lib/status'
import { CloseIcon } from './Icons'
import { tip } from './Tooltip'

/**
 * The one place messages appear: a stack in the column's bottom corner. It's apart from the dock,
 * so a message coming or going never moves the dock (which can be dragged anywhere) or its button.
 * The newest, most pressing message sits nearest the corner.
 */
export function ToastStack({ children }: { children: ReactNode }) {
  // Polite: progress and confirmations are read out when they appear, never interrupting.
  return (
    <div className="toast-stack" aria-live="polite">
      {children}
    </div>
  )
}

type ToastProps = {
  /** Errors are tinted red; everything else looks the same. */
  tone?: 'normal' | 'error' | undefined
  /** A small mark before the text: a spinner for work in progress, a dot for recording. */
  icon?: 'spinner' | 'dot' | undefined
  text: ReactNode
  /** Secondary words at the end of the line: a percentage, or how long is left. */
  detail?: string | null | undefined
  /** 0–1 draws a bar under the line. */
  progress?: number | null | undefined
  /** A `.toast-action` button (Undo, Got it, Open Settings). */
  action?: ReactNode
  onDismiss?: (() => void) | undefined
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>

/**
 * Every message in the stack, so they all look alike: Undo confirmations, background work and
 * recorder notices differ only in their words, an optional mark, button or bar.
 */
export function Toast({
  tone = 'normal',
  icon,
  text,
  detail,
  progress,
  action,
  onDismiss,
  ...rest
}: ToastProps) {
  return (
    <div className={tone === 'error' ? 'toast is-error' : 'toast'} {...rest}>
      <div className="toast-row">
        {icon === 'spinner' ? <span className="toast-spinner" aria-hidden="true" /> : null}
        {icon === 'dot' ? <span className="toast-dot" aria-hidden="true" /> : null}
        <span className="toast-text">{text}</span>
        {/* Ticks every second or percent; reading each one out would drown everything else. */}
        {detail ? (
          <span className="toast-detail" aria-hidden="true">
            {detail}
          </span>
        ) : null}
        {action}
        {onDismiss ? (
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss"
            {...tip('Dismiss')}
            onClick={onDismiss}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {progress === null || progress === undefined ? null : (
        <span className="toast-progress" aria-hidden="true">
          <span style={{ width: `${String(progress * 100)}%` }} />
        </span>
      )}
    </div>
  )
}

/** Background work: its words, a spinner or progress bar, and how far along it is. */
export function ActivityToast({
  activity,
  onDismiss
}: {
  activity: Activity
  onDismiss?: () => void
}) {
  return (
    <Toast
      tone={activity.tone === 'error' ? 'error' : 'normal'}
      icon={activity.tone === 'busy' && activity.progress === null ? 'spinner' : undefined}
      text={activity.text}
      detail={activity.detail}
      progress={activity.progress}
      onDismiss={onDismiss}
      {...(activity.tone === 'error' ? { role: 'alert' } : {})}
    />
  )
}

/** Ticks once a second while `running`, for counting down an estimate. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [running])
  return now
}

/** The open session's processing (labeling speakers, writing the summary), with time left. */
export function ProcessingToast({ pageId }: { pageId: string }) {
  const status = useMeetingStatus(pageId)
  const now = useNow(status?.estimate !== undefined && status.state === 'diarizing')
  if (!status) return null
  const activity = processingActivity(status, now)
  return (
    <ActivityToast
      activity={activity}
      {...(activity.tone === 'error' ? { onDismiss: () => dismissMeetingStatus(pageId) } : {})}
    />
  )
}

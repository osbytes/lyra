import { useEffect, useState, type ReactNode } from 'react'
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

/** Background work: a spinner or progress bar, its words, and how far along it is. */
export function ActivityToast({
  activity,
  onDismiss
}: {
  activity: Activity
  onDismiss?: () => void
}) {
  return (
    <div
      className={`activity-toast is-${activity.tone}`}
      {...(activity.tone === 'error' ? { role: 'alert' } : {})}
    >
      <div className="activity-row">
        {activity.tone === 'busy' && activity.progress === null ? (
          <span className="activity-spinner" aria-hidden="true" />
        ) : null}
        <span className="activity-text">{activity.text}</span>
        {/* Ticks every second or percent; reading each one out would drown everything else. */}
        {activity.detail ? (
          <span className="activity-detail" aria-hidden="true">
            {activity.detail}
          </span>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className="activity-dismiss"
            aria-label="Dismiss"
            {...tip('Dismiss')}
            onClick={onDismiss}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {activity.progress === null ? null : (
        <span className="activity-progress" aria-hidden="true">
          <span style={{ width: `${String(activity.progress * 100)}%` }} />
        </span>
      )}
    </div>
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

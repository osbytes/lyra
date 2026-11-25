import { useMeetingStatus } from '../hooks/useMeetingStatus'
import { statusBusy, statusLabel } from '../lib/status'
import { tip } from './Tooltip'

type Props = {
  pageId: string
}

/**
 * The session's processing status. It lives in the transcript's header bar, outside the scroller,
 * so it stays in view however far the transcript is scrolled and even when it's collapsed.
 */
export function MeetingStatus({ pageId }: Props): React.JSX.Element {
  const status = useMeetingStatus(pageId)
  const busy = status ? statusBusy(status) : false
  const label = status ? statusLabel(status) : ''
  return (
    // Always present, so screen readers hear the status as it appears and changes.
    <span className="meeting-status-live" aria-live="polite">
      {status && status.state !== 'done' ? (
        <span
          className={
            status.state === 'error'
              ? 'meeting-status is-error'
              : busy
                ? 'meeting-status is-busy'
                : 'meeting-status'
          }
          {...tip(
            status.task === 'speakers' && busy
              ? `${label} Speaker names and line breaks may still change until this finishes.`
              : label
          )}
        >
          {busy ? <span className="meeting-status-spinner" aria-hidden="true" /> : null}
          <span className="meeting-status-text">{label}</span>
        </span>
      ) : null}
    </span>
  )
}

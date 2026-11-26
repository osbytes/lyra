import { useEffect, useRef, useState } from 'react'
import { activityFace, type ActivityAction, type ActivityItem } from '../../../shared/activity'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ipcErrorMessage } from '../lib/ipcError'
import { log } from '../lib/log'
import { CheckIcon, CloseIcon } from './Icons'
import { Floating } from './Controls'
import { tip } from './Tooltip'

/** Past this many rows the list folds, so Activity never pushes the sessions out of the sidebar. */
const FOLD_AFTER = 2

type ListProps = {
  visible: readonly ActivityItem[]
  /** A session's title, for rows about one session. */
  pageTitle: (pageId: string) => string | null
  onOpen: (pageId: string) => void
}

function actionLabel(item: ActivityItem, action: ActivityAction): string {
  switch (action) {
    case 'cancel':
      return item.kind === 'backfill' || item.kind === 'notes' ? 'Stop' : 'Cancel'
    case 'retry':
      return 'Retry'
    case 'install':
      return item.title === 'Restart to update' ? 'Restart' : 'Install'
    case 'open':
      return 'Open'
  }
}

function ActivityRow({ item, pageTitle, onOpen }: { item: ActivityItem } & Omit<ListProps, 'visible'>) {
  const [busy, setBusy] = useState(false)
  const session = item.pageId ? pageTitle(item.pageId) : null
  const ended = item.state !== 'running' && item.state !== 'waiting'
  const percent = item.progress === null ? null : Math.floor(item.progress * 100)
  const run = async (action: ActivityAction): Promise<void> => {
    if (action === 'open') {
      if (item.pageId) onOpen(item.pageId)
      return
    }
    setBusy(true)
    try {
      await window.api.activityAct(item.id, action)
    } catch (error) {
      log('activity', 'action failed', { id: item.id, action, error: ipcErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={`activity-row is-${item.state}`}>
      <div className="activity-head">
        {item.state === 'running' ? <span className="activity-spinner" aria-hidden="true" /> : null}
        {item.state === 'done' ? <CheckIcon /> : null}
        {item.state === 'failed' || item.state === 'partial' ? (
          <span className="activity-warn" aria-hidden="true">
            !
          </span>
        ) : null}
        <span className="activity-title">
          {item.title}
          {session ? <span className="activity-session">{session}</span> : null}
        </span>
        {percent === null || item.state !== 'running' ? null : <span className="activity-percent">{percent}%</span>}
      </div>
      {item.detail ? <span className="activity-detail">{item.detail}</span> : null}
      {item.state === 'running' && percent !== null ? (
        <div
          className="activity-bar"
          role="progressbar"
          aria-label={item.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={item.detail ?? `${String(percent)}%`}
        >
          <span style={{ width: `${String(percent)}%` }} />
        </div>
      ) : null}
      {item.actions.length || ended ? (
        <div className="activity-actions">
          {item.actions.map((action) => (
            <button key={action} className="activity-action" type="button" disabled={busy} onClick={() => void run(action)}>
              {actionLabel(item, action)}
            </button>
          ))}
          {ended ? (
            <button
              className="activity-dismiss"
              type="button"
              aria-label={`Dismiss: ${item.title}`}
              {...tip('Dismiss')}
              onClick={() => void window.api.dismissActivity(item.id)}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Announces new tasks, new phases and endings to screen readers, never every percent
 * (docs/STATES.md, Accessibility).
 */
function useAnnouncement(visible: readonly ActivityItem[]): string {
  const seen = useRef(new Set<string>())
  const [text, setText] = useState('')
  useEffect(() => {
    for (const item of visible) {
      const key = `${item.id}|${item.state}|${item.title}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      setText(item.state === 'failed' && item.detail ? `${item.title}: ${item.detail}` : item.title)
    }
  }, [visible])
  return text
}

function ActivityList({ visible, pageTitle, onOpen, folds }: ListProps & { folds: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const shown = folds && !expanded ? visible.slice(0, FOLD_AFTER) : visible
  const hidden = visible.length - shown.length
  return (
    <>
      <ul className="activity-list">
        {shown.map((item) => (
          <ActivityRow key={item.id} item={item} pageTitle={pageTitle} onOpen={onOpen} />
        ))}
      </ul>
      {hidden > 0 ? (
        <button className="activity-more" type="button" onClick={() => setExpanded(true)}>
          {hidden} more · Show all
        </button>
      ) : null}
      {folds && expanded && visible.length > FOLD_AFTER ? (
        <button className="activity-more" type="button" onClick={() => setExpanded(false)}>
          Show fewer
        </button>
      ) : null}
    </>
  )
}

/** Activity in the sidebar footer: nothing at all when there's no work. */
export function ActivityFooter(props: ListProps) {
  const announcement = useAnnouncement(props.visible)
  if (!props.visible.length) {
    return (
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    )
  }
  return (
    <section className="activity" aria-label="Activity">
      <h2 className="activity-heading">Activity</h2>
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
      <ActivityList {...props} folds />
    </section>
  )
}

/** The progress ring on the collapsed button: a sweep, or a spinner when it can't be measured. */
function Ring({ progress }: { progress: number | null }) {
  if (progress === null) return <span className="activity-spinner" aria-hidden="true" />
  const circumference = 2 * Math.PI * 6
  return (
    <svg className="activity-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" className="activity-ring-track" />
      <circle
        cx="8"
        cy="8"
        r="6"
        className="activity-ring-fill"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
      />
    </svg>
  )
}

/**
 * Activity when the sidebar is hidden: one top-bar button showing the most urgent thing (a
 * failure before any percentage), with the same rows in a popover.
 */
export function ActivityButton(props: ListProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const face = activityFace(props.visible)
  const announcement = useAnnouncement(props.visible)
  const shown = open && face !== null
  useDialogFocus(popover, shown)
  useEffect(() => {
    if (!face) setOpen(false)
  }, [face])
  const close = (): void => {
    setOpen(false)
    anchor.current?.focus()
  }
  const rect = shown ? anchor.current?.getBoundingClientRect() : undefined
  return (
    <>
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
      {face ? (
        <button
          ref={anchor}
          className={`activity-button no-drag is-${face.tone}`}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={shown}
          aria-label={`Activity: ${face.label}`}
          {...tip('Activity')}
          onClick={() => setOpen((value) => !value)}
        >
          {face.tone === 'working' ? <Ring progress={face.progress} /> : null}
          {face.tone === 'attention' ? <span className="activity-dot" aria-hidden="true" /> : null}
          {face.tone === 'done' ? <CheckIcon /> : null}
          <span className="activity-button-label">{face.label}</span>
        </button>
      ) : null}
      {shown && rect ? (
        <Floating>
          <div className="picker-layer" onMouseDown={close}>
            <div
              ref={popover}
              className="picker activity-popover"
              role="dialog"
              aria-modal="true"
              aria-label="Activity"
              style={{ top: rect.bottom + 8, left: Math.max(8, Math.min(window.innerWidth - 328, rect.left)) }}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                close()
              }}
            >
              <h2 className="activity-heading">Activity</h2>
              <ActivityList
                {...props}
                onOpen={(pageId) => {
                  close()
                  props.onOpen(pageId)
                }}
                folds={false}
              />
            </div>
          </div>
        </Floating>
      ) : null}
    </>
  )
}

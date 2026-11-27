import { useEffect, useRef, useState } from 'react'
import { activityFace, type ActivityAction, type ActivityItem } from '../../../shared/activity'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ipcErrorMessage } from '../lib/ipcError'
import { log } from '../lib/log'
import { cn } from '../lib/utils'
import { Floating } from './Controls'
import { CheckIcon, CloseIcon, ErrorIcon, GaugeIcon, InfoIcon, WarningIcon } from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { Spinner } from './ui/status'

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
      return item.title === 'Restart to update' ? 'Restart now' : 'Install'
    case 'open':
      return 'Open'
    case 'turnOff':
      return item.kind === 'speakers' ? 'Use the standard model' : 'Turn off'
  }
}

/** Each state by shape first: spinner, check, triangle (partial), octagon (failed), circle (waiting). */
function StateIcon({ item }: { item: ActivityItem }) {
  switch (item.state) {
    case 'running':
      return <Spinner className="mt-[3px]" />
    case 'done':
      return <CheckIcon className="text-success" />
    case 'partial':
      return <WarningIcon className="text-warning" />
    case 'failed':
      return <ErrorIcon className="text-destructive" />
    case 'waiting':
      return <InfoIcon className="text-info" />
  }
}

/**
 * One task: icon, what's happening, its detail, and its actions; a bar with real units while it
 * runs. Failed and waiting rows lead; partial says what worked first and retries only failures.
 */
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
    <li
      className={cn(
        'activity-row grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-b border-border px-3 py-2.5 text-body-sm last:border-b-0',
        `is-${item.state}`
      )}
    >
      <span className="grid place-items-center pt-px">
        <StateIcon item={item} />
      </span>
      <span className="min-w-0 font-medium text-foreground">
        {item.title}
        {session ? <span className="font-normal text-text-3"> · {session}</span> : null}
      </span>
      <span className="flex items-center gap-1">
        {item.actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'install' ? 'primary' : action === 'cancel' ? 'ghost' : 'secondary'}
            disabled={busy}
            onClick={() => void run(action)}
          >
            {actionLabel(item, action)}
          </Button>
        ))}
        {ended ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Dismiss: ${item.title}`}
            {...tip('Dismiss')}
            onClick={() => void window.api.dismissActivity(item.id)}
          >
            <CloseIcon />
          </Button>
        ) : null}
      </span>
      {item.detail || (item.state === 'running' && percent !== null) ? (
        <span className="col-start-2 col-end-4 text-label text-text-3">
          {item.detail ?? `${String(percent)}%`}
        </span>
      ) : null}
      {item.state === 'running' && percent !== null ? (
        <Progress
          className="col-start-2 col-end-4 mt-1"
          value={percent}
          aria-label={item.title}
          aria-valuetext={item.detail ?? `${String(percent)}%`}
        />
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

/** The groups of the Activity panel: what needs the person, what's running, what finished. */
function ActivityList({ visible, pageTitle, onOpen }: ListProps) {
  const groups = [
    { label: 'Needs you', items: visible.filter((i) => i.state === 'failed' || i.state === 'partial' || i.state === 'waiting') },
    { label: 'Running', items: visible.filter((i) => i.state === 'running') },
    { label: 'Done', items: visible.filter((i) => i.state === 'done') }
  ].filter((group) => group.items.length)
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="m-0 bg-muted px-3 py-1 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">
            {group.label}
            {group.label === 'Done' ? ` · ${String(group.items.length)}` : ''}
          </h3>
          <ul className="activity-list m-0 list-none p-0">
            {group.items.map((item) => (
              <ActivityRow key={item.id} item={item} pageTitle={pageTitle} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/**
 * The activity pill in the status bar: the most urgent thing (a failure before any percentage),
 * opening the Activity panel above it. Nothing at all when there's no work.
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
          className={cn(
            'activity-button no-drag inline-flex h-5 items-center gap-1.5 rounded-full border-(length:--border-width) border-border bg-muted px-2 text-[11.5px] text-text-2',
            'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            face.tone === 'attention' && 'border-destructive/40 text-destructive'
          )}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={shown}
          aria-label={`Activity: ${face.label}`}
          {...tip('Activity')}
          onClick={() => setOpen((value) => !value)}
        >
          {face.tone === 'working' ? <Spinner className="size-2.5" /> : null}
          {face.tone === 'attention' ? <ErrorIcon size={12} /> : null}
          {face.tone === 'done' ? <CheckIcon size={12} className="text-success" /> : null}
          {face.label}
        </button>
      ) : null}
      {shown && rect ? (
        <Floating>
          <div className="picker-layer" onMouseDown={close}>
            <div
              ref={popover}
              className="activity-popover fixed z-[100] w-[380px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border-(length:--border-width) border-border bg-popover text-popover-foreground shadow-md"
              role="dialog"
              aria-modal="true"
              aria-label="Activity"
              style={{
                bottom: window.innerHeight - rect.top + 8,
                left: Math.max(8, Math.min(window.innerWidth - 388, rect.right - 380))
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                close()
              }}
            >
              <h2 className="m-0 flex items-center gap-2 border-b border-border px-3 py-2 text-body-sm font-semibold">
                <GaugeIcon />
                Activity
              </h2>
              <div className="max-h-[60vh] overflow-y-auto">
                <ActivityList
                  {...props}
                  onOpen={(pageId) => {
                    close()
                    props.onOpen(pageId)
                  }}
                />
              </div>
            </div>
          </div>
        </Floating>
      ) : null}
    </>
  )
}

import type { HTMLAttributes, ReactNode } from 'react'
import type { Activity } from '../lib/status'
import { cn } from '../lib/utils'
import { CloseIcon, ErrorIcon } from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { LiveDot, Spinner } from './ui/status'

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
    <div
      className={cn(
        'toast w-[380px] max-w-full overflow-hidden rounded-lg text-body-sm shadow-lg',
        tone === 'error'
          ? 'is-error border-(length:--border-width) border-destructive/40 bg-destructive-soft text-foreground'
          : 'border-(length:--border-width) border-border bg-popover text-popover-foreground'
      )}
      {...rest}
    >
      <div className="flex min-h-10 items-center gap-3 py-2 pr-2 pl-3.5">
        {icon === 'spinner' ? <Spinner className="size-3" /> : null}
        {icon === 'dot' ? <LiveDot live={false} /> : null}
        {tone === 'error' ? <ErrorIcon className="shrink-0 text-destructive" /> : null}
        <span className="toast-text min-w-0 flex-1">{text}</span>
        {/* Ticks every second or percent; reading each one out would drown everything else. */}
        {detail ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums opacity-75" aria-hidden="true">
            {detail}
          </span>
        ) : null}
        {action}
        {onDismiss ? (
          <Button
            size="icon-sm"
            variant="ghost"

            aria-label="Dismiss"
            {...tip('Dismiss')}
            onClick={onDismiss}
          >
            <CloseIcon />
          </Button>
        ) : null}
      </div>
      {progress === null || progress === undefined ? null : (
        <span className="block h-0.5 bg-surface-3" aria-hidden="true">
          <span className="block h-full bg-primary" style={{ width: `${String(progress * 100)}%` }} />
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

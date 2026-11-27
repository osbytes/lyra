import type { ComponentProps } from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * A spinner for 0.4 s+ waits. With reduced motion it stops and turns dotted; the status word
 * beside it carries the state.
 */
export function Spinner({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="spinner"
      className={cn(
        'inline-block size-3.5 shrink-0 rounded-full border-2 border-current border-r-transparent',
        'animate-spin motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-r-current',
        className
      )}
      {...props}
    />
  )
}

/** The recording dot: the only red thing in the app, pulsing while live. */
export function LiveDot({ className, live = true, ...props }: ComponentProps<'span'> & { live?: boolean }) {
  return (
    <span
      data-slot="live-dot"
      className={cn('inline-block size-2 shrink-0 rounded-full bg-record', live && 'live-pulse', className)}
      {...props}
    />
  )
}

/** A key, as in a shortcut. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-block min-w-[1.6em] rounded-xs border-(length:--border-width) border-b-2 border-input bg-card px-[0.4em]',
        'text-center font-mono text-[11px] leading-[16px] text-foreground',
        className
      )}
      {...props}
    />
  )
}

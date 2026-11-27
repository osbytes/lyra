import type { ComponentProps } from 'react'
import { Progress as ProgressPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * A 6 px bar. Determinate with a value; without one it's indeterminate (only when no real unit
 * exists), and with reduced motion that becomes a faint full bar. Label it with
 * `aria-valuetext` in real units ("63 of 575 MB"), never only a percent.
 */
export function Progress({
  className,
  value,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  const known = typeof value === 'number'
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-[200ms] ease-standard',
          !known && 'progress-indeterminate w-[30%]'
        )}
        style={known ? { width: `${String(Math.max(0, Math.min(100, value)))}%` } : undefined}
      />
    </ProgressPrimitive.Root>
  )
}

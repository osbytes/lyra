import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

/**
 * Chips: where machine output was made, and what a thing is doing. Local is a quiet badge of
 * quality; cloud is outlined and always names the provider. In high contrast every chip gets a
 * border in its own colour, since the soft fills turn black.
 */
export const badgeVariants = cva(
  [
    'inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full border-(length:--border-width) border-transparent px-2',
    'text-[11.5px] font-medium whitespace-nowrap hc:border-current [&_svg]:size-[13px] [&_svg]:shrink-0'
  ],
  {
    variants: {
      tone: {
        local: 'bg-local-soft text-local',
        cloud: 'border-cloud/45 bg-cloud-soft text-cloud',
        record: 'bg-record-soft text-record',
        work: 'border-border bg-muted text-text-2',
        mine: 'border-border bg-muted text-text-2',
        warning: 'bg-warning-soft text-warning',
        success: 'bg-success-soft text-success',
        danger: 'bg-destructive-soft text-destructive',
        info: 'bg-info-soft text-info'
      }
    },
    defaultVariants: { tone: 'work' }
  }
)

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

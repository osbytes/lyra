import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

/**
 * The interface system's button. Primary is the one main action in a view; secondary (the
 * default) is outlined with the control edge; ghost has no edge; danger names what it destroys
 * ("Delete audio") and carries the octagon icon; record is live capture only.
 * Disabled buttons that need a reason use `aria-disabled` so they stay focusable.
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap',
    'border-(length:--border-width) select-none',
    'transition-[background-color,border-color,color] duration-[120ms] ease-standard',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'active:translate-y-px active:brightness-95',
    'disabled:pointer-events-none disabled:border-border disabled:bg-surface-2 disabled:text-text-3',
    'aria-disabled:cursor-not-allowed aria-disabled:border-border aria-disabled:bg-surface-2 aria-disabled:text-text-3',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
  ],
  {
    variants: {
      variant: {
        secondary: 'border-input bg-card text-foreground hover:bg-accent',
        primary: 'border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
        ghost: 'border-transparent bg-transparent text-text-2 hover:bg-accent hover:text-foreground',
        danger: 'border-destructive bg-card text-destructive hover:bg-destructive-soft',
        record: 'border-record bg-record text-record-foreground hover:brightness-95',
        link: 'h-auto border-transparent bg-transparent px-0 text-brand-text underline-offset-2 hover:underline'
      },
      size: {
        sm: 'h-[26px] px-[9px] text-label',
        md: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-4 text-body',
        icon: 'size-8 p-0',
        'icon-sm': 'size-[26px] p-0'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (e.g. a link) with the button's look instead of a `<button>`. */
    asChild?: boolean
  }

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? 'secondary'}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

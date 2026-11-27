import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/** 32 × 18 track, thumb slides 14 px (motion.base). Accent when on. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full',
        'bg-input transition-colors duration-[200ms] ease-standard data-[state=checked]:bg-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-default disabled:opacity-45',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-card',
          'transition-transform duration-[200ms] ease-standard',
          'data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

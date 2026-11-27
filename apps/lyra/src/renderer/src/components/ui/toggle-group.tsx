import type { ComponentProps } from 'react'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/** The segmented control: a sunken well, the chosen option raised on surface 1. */
export function ToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn(
        'inline-flex max-w-full min-w-0 shrink-0 gap-0.5 rounded-lg border-(length:--border-width) border-border bg-muted p-0.5',
        className
      )}
      {...props}
    />
  )
}

export function ToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex h-[26px] min-w-0 items-center justify-center gap-1.5 rounded-sm px-2.5 text-[12.5px] font-medium whitespace-nowrap text-text-2',
        'hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        'data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm',
        'data-[state=on]:outline-(length:--border-width) data-[state=on]:outline-border',
        '[&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  )
}

import type { ComponentProps } from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'
import { CheckIcon, ChevronDownIcon } from '../Icons'

export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

/** `field` looks like an input (Preferences); `ghost` is a quiet inline control (the dock). */
export function SelectTrigger({
  className,
  children,
  variant = 'field',
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { variant?: 'field' | 'ghost' }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      className={cn(
        'flex h-8 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-sm px-2.5 text-body whitespace-nowrap',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:cursor-default disabled:border-border disabled:bg-surface-2 disabled:text-text-3',
        '[&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate [&>span]:text-left [&_svg]:shrink-0',
        variant === 'field'
          ? 'border-(length:--border-width) border-input bg-card text-foreground'
          : 'border-(length:--border-width) border-transparent bg-transparent text-text-2 hover:bg-accent hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-text-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn(
          'relative z-[100] max-h-(--radix-select-content-available-height) min-w-[max(var(--radix-select-trigger-width),200px)] [-webkit-app-region:no-drag]',
          'overflow-x-hidden overflow-y-auto rounded-lg border-(length:--border-width) border-border bg-popover p-1 text-body-sm text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({
  className,
  children,
  hint,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & { hint?: string | undefined }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-[30px] cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-7 outline-none select-none',
        'data-highlighted:bg-brand-soft data-highlighted:text-brand-text hc:data-highlighted:outline-2 hc:data-highlighted:outline-ring',
        'data-disabled:pointer-events-none data-disabled:text-text-3',
        className
      )}
      {...props}
    >
      <span className="absolute left-2 grid size-4 place-items-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="grid min-w-0">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {hint ? <small className="text-label text-text-3">{hint}</small> : null}
      </span>
    </SelectPrimitive.Item>
  )
}

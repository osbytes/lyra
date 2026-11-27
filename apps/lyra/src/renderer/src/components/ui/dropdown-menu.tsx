import type { ComponentProps } from 'react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * Menus: overlay surface, radius.md, elevation 2. Items are 30 px; the active item takes the
 * accent's soft fill. Destructive items go last, in danger colour; disabled items keep their
 * place and say why in the shortcut slot.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[100] max-h-(--radix-dropdown-menu-content-available-height) min-w-[220px] overflow-x-hidden overflow-y-auto [-webkit-app-region:no-drag]',
          'rounded-lg border-(length:--border-width) border-border bg-popover p-1 text-body-sm text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  danger = false,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-danger={danger || undefined}
      className={cn(
        'relative flex h-[30px] cursor-default items-center gap-2 rounded-sm px-2 outline-none select-none',
        'data-highlighted:bg-brand-soft data-highlighted:text-brand-text hc:data-highlighted:outline-2 hc:data-highlighted:outline-ring',
        'data-disabled:text-text-3 data-[danger]:text-destructive data-[danger]:data-highlighted:bg-destructive-soft data-[danger]:data-highlighted:text-destructive',
        '[&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn('px-2 pt-1.5 pb-0.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('mx-0.5 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

/** The right edge of an item: its shortcut, or why it's unavailable. */
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto pl-4 font-mono text-[11px] text-text-3', className)}
      {...props}
    />
  )
}

import type { ComponentProps } from 'react'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'
import { buttonVariants } from './button'

/**
 * A decision dialog (never feedback): the title is the question, the body states the
 * consequence, the buttons are verbs that repeat the outcome. Focus starts on the safe choice
 * and Escape means the safe choice.
 */
export const AlertDialog = AlertDialogPrimitive.Root

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-[300] bg-(--backdrop) [-webkit-app-region:no-drag] data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-[300] grid w-[440px] [-webkit-app-region:no-drag] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 gap-3',
          'rounded-xl border-(length:--border-width) border-border bg-popover p-5 text-body text-popover-foreground shadow-lg',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]',
          className
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('m-0 text-base leading-6 font-semibold text-balance', className)}
      {...props}
    />
  )
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('m-0 text-text-2', className)}
      {...props}
    />
  )
}

/** Buttons in the platform's order: confirming action last on macOS, first on Windows. */
export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        'mt-1 flex flex-wrap justify-end gap-2 [[data-platform=win32]_&]:flex-row-reverse [[data-platform=win32]_&]:justify-start',
        className
      )}
      {...props}
    />
  )
}

export function AlertDialogAction({
  className,
  danger = false,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & { danger?: boolean }) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant: danger ? 'danger' : 'primary' }), className)}
      {...props}
    />
  )
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: 'secondary' }), className)}
      {...props}
    />
  )
}

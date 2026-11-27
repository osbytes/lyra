import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button } from './ui/button'

type Props = {
  title: string
  children?: ReactNode
  /** The confirming button's label, a verb that repeats the outcome ("Delete session"). */
  confirm: string
  /** The safe choice's label, when it says more than "Cancel" ("Keep my summary"). */
  cancel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A decision, never feedback: the title is the question and the body the consequence. Focus
 * starts on Cancel (the safe choice) and Escape cancels. A click outside does nothing: a decision
 * is made with a button.
 */
export function ConfirmDialog({ title, children, confirm, cancel = 'Cancel', danger = false, onConfirm, onCancel }: Props) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent
        className="confirm"
      >
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {children ? (
          <AlertDialogDescription asChild>
            <div className="confirm-body">{children}</div>
          </AlertDialogDescription>
        ) : null}
        <AlertDialogFooter className="confirm-buttons">
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          {/* A plain button, not Radix's Action: closing through Action would also report a cancel. */}
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

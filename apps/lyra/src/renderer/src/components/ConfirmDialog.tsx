import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Floating } from './Controls'
import { useDialogFocus } from '../hooks/useDialogFocus'

type Props = {
  title: string
  children?: ReactNode
  /** The confirming button's label, e.g. "Delete session". */
  confirm: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A themed yes/no question, instead of `window.confirm` (unstyled, and blocks the window).
 * Enter confirms, Escape or clicking outside cancels; focus starts on the confirming button.
 */
export function ConfirmDialog({ title, children, confirm, danger = false, onConfirm, onCancel }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  const titleId = useId()
  const bodyId = useId()

  useDialogFocus(dialog, true)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <Floating>
    <div className="modal-backdrop confirm-backdrop" onMouseDown={onCancel}>
      <div
        ref={dialog}
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        {children ? (
          <div id={bodyId} className="confirm-body">
            {children}
          </div>
        ) : null}
        <div className="confirm-buttons">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            data-autofocus
            className={danger ? 'btn primary is-danger' : 'btn primary'}
            type="button"
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
    </Floating>
  )
}

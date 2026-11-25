/**
 * Brief confirmations ("Copied", "Deleted …") with an optional button. App draws the one toast
 * above the dock; anything in the window can raise it, so feedback looks the same everywhere.
 */

export type ToastMessage = { text: string; action?: { label: string; run: () => void } }

const listeners = new Set<(toast: ToastMessage) => void>()

export function notify(text: string, action?: ToastMessage['action']): void {
  for (const listener of listeners) listener(action ? { text, action } : { text })
}

export function onToast(listener: (toast: ToastMessage) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether `next` should take the toast slot from `current`. A plain notice ("Copied") never
 * pushes out one that offers an action (Undo): that one stays until it is used or times out, and
 * the notice is dropped, since showing it late would only confuse.
 */
export function replacesToast(current: ToastMessage | null, next: ToastMessage): boolean {
  return !current?.action || next.action !== undefined
}

import { useEffect, type RefObject } from 'react'
import { nextTrapIndex } from '../lib/focus'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * Open dialogs, newest last. Only the newest traps Tab, so a confirm opened over Settings keeps
 * focus to itself and hands it back when it closes.
 */
const stack: symbol[] = []

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.hidden && element.getClientRects().length > 0
  )
}

/**
 * Modal focus handling for a dialog rendered into `ref`: while `open`, focus moves into it (the
 * first `[data-autofocus]` element, else the first focusable one, else the dialog itself), Tab and
 * Shift+Tab cycle inside it, and when it closes or unmounts focus goes back to whatever had it
 * before, if that is still on the page and nothing else has taken focus meanwhile.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return
    const id = Symbol('dialog')
    stack.push(id)
    const previous = document.activeElement
    const root = ref.current
    if (root && !root.contains(document.activeElement)) {
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root
      if (target === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
      target.focus()
    }

    const onKey = (event: KeyboardEvent): void => {
      // Bubble phase, after React: a dialog that gives Tab its own meaning prevents it first.
      if (event.key !== 'Tab' || event.defaultPrevented || stack.at(-1) !== id) return
      const current = ref.current
      if (!current) return
      const items = focusables(current)
      const active = document.activeElement
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1
      const next = nextTrapIndex(index, items.length, event.shiftKey)
      const target = next === null ? current : items[next]
      if (!target) return
      event.preventDefault()
      target.focus()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      const at = stack.indexOf(id)
      if (at !== -1) stack.splice(at, 1)
      // Something the dialog started (a command, another dialog) may have placed focus itself;
      // only take it back when it was left in the dialog or dropped to the page.
      const now = document.activeElement
      const dropped = !now || now === document.body || (root?.contains(now) ?? false)
      if (dropped && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [ref, open])
}

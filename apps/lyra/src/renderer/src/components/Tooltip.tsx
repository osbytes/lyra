import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Floating } from './Controls'

/** Hovering waits this long; moving to a neighbour while one is showing switches at once. */
const SHOW_MS = 450
const WARM_MS = 400
const GAP = 6
const EDGE = 8

type Shown = { text: string; shortcut: string | null; anchor: DOMRect; target: HTMLElement }

/**
 * Props that give an element a tooltip: `<button {...tip('Settings', shortcutLabel(','))}>`.
 * Never use `title`: it can't be themed, is slow, and never shows for keyboard focus.
 */
export function tip(
  text: string,
  shortcut?: string
): { 'data-tooltip': string; 'data-tooltip-shortcut'?: string } {
  return shortcut ? { 'data-tooltip': text, 'data-tooltip-shortcut': shortcut } : { 'data-tooltip': text }
}

function tipped(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null
}

/**
 * Draws the tooltip for whichever `[data-tooltip]` element is hovered or keyboard-focused.
 * Mounted once per window, so every control gets the same delay, look and placement.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number; below: boolean } | null>(null)
  const node = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let current: HTMLElement | null = null
    let hiddenAt = 0

    const show = (target: HTMLElement): void => {
      const text = target.dataset.tooltip
      if (!text) return
      setShown({
        text,
        shortcut: target.dataset.tooltipShortcut ?? null,
        anchor: target.getBoundingClientRect(),
        target
      })
    }
    const hide = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (current) hiddenAt = Date.now()
      current = null
      setShown(null)
    }
    const arm = (target: HTMLElement, delay: number): void => {
      if (target === current) return
      if (timer) clearTimeout(timer)
      current = target
      const warm = Date.now() - hiddenAt < WARM_MS
      timer = setTimeout(() => show(target), warm ? 0 : delay)
    }

    const onOver = (event: PointerEvent): void => {
      const target = tipped(event.target)
      if (target) arm(target, SHOW_MS)
      else if (current) hide()
    }
    const onFocus = (event: FocusEvent): void => {
      const target = tipped(event.target)
      // Keyboard focus only: a click also focuses, and the hover already handled it.
      if (target?.matches(':focus-visible')) arm(target, 0)
    }
    const onBlur = (event: FocusEvent): void => {
      if (tipped(event.target) === current) hide()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current) hide()
    }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', onBlur)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onBlur)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Screen readers hear the tooltip as the control's description while it's shown.
  useEffect(() => {
    if (!shown) return
    const { target } = shown
    const before = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', before ? `${before} ${id}` : id)
    return () => {
      if (before) target.setAttribute('aria-describedby', before)
      else target.removeAttribute('aria-describedby')
    }
  }, [shown, id])

  // Above the element when there's room, else below; centred, and kept inside the window.
  useLayoutEffect(() => {
    if (!shown || !node.current) {
      setPlace(null)
      return
    }
    const size = node.current.getBoundingClientRect()
    const { anchor } = shown
    const below = anchor.top - size.height - GAP < EDGE
    const top = below ? anchor.bottom + GAP : anchor.top - size.height - GAP
    const centre = anchor.left + anchor.width / 2 - size.width / 2
    const left = Math.max(EDGE, Math.min(centre, window.innerWidth - size.width - EDGE))
    setPlace({ top, left, below })
  }, [shown])

  if (!shown) return null
  return (
    <Floating>
      <div
        ref={node}
        id={id}
        role="tooltip"
        className={`tooltip${place?.below ? ' below' : ''}`}
        style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
      >
        {shown.text}
        {shown.shortcut ? <kbd>{shown.shortcut}</kbd> : null}
      </div>
    </Floating>
  )
}

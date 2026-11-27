import { useLayoutEffect, useState, type RefObject } from 'react'
import { placeNear } from '../lib/placement'

/**
 * Positions a fixed popover in `ref` next to `anchor`, from its measured size rather than a
 * guess: placed before paint, and again whenever its content (a filtered list, a hint) or the
 * window changes size, so no part of it ends up off screen.
 */
export function useAnchoredPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: DOMRect
): { top: number; left: number } {
  const [position, setPosition] = useState({ top: anchor.bottom + 8, left: anchor.left })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const place = (): void => {
      const next = placeNear(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
      setPosition((current) => (current.top === next.top && current.left === next.left ? current : next))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [ref, anchor])
  return position
}

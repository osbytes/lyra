import type { RefObject } from 'react'
import { tip } from './Tooltip'

export type PanelLayout = { open: boolean; width: number }

type Limits = { min: number; max: number; initial: number; closeBelow: number }

type Props = {
  /** The window edge the panel sits against; dragging toward it narrows the panel. */
  side: 'left' | 'right'
  layout: PanelLayout
  limits: Limits
  /** The element whose `cssVar` sizes the panel, written directly while dragging. */
  target: RefObject<HTMLElement | null>
  cssVar: string
  /** The widest the panel may be right now, so the page between keeps its room. */
  room: () => number
  label: string
  /** The panel opened or closed mid-drag, as the pointer crossed `closeBelow`. */
  onOpenChange: (open: boolean) => void
  /** The drag or key press is done: keep this layout. */
  onCommit: (layout: PanelLayout) => void
}

/** Arrow keys move the edge this far. */
const KEY_STEP = 16

/**
 * Where a pointer `wanted` the panel's width to be: below `closeBelow` it closes, between that
 * and `min` it holds at `min` (the snap), and it never grows past `max` or the room left.
 */
function placeEdge(wanted: number, limits: Limits, room: number, last: number): PanelLayout {
  // A closed panel keeps the width it had, to open at it again.
  if (wanted < limits.closeBelow) return { open: false, width: last }
  const max = Math.max(limits.min, Math.min(limits.max, room))
  return { open: true, width: Math.round(Math.min(max, Math.max(limits.min, wanted))) }
}

/**
 * The draggable edge of a side panel. It stays at the window's edge while the panel is closed,
 * so dragging it out opens the panel again.
 */
export function PanelResizer({
  side,
  layout,
  limits,
  target,
  cssVar,
  room,
  label,
  onOpenChange,
  onCommit
}: Props) {
  const write = (placed: PanelLayout): void => {
    if (placed.open) target.current?.style.setProperty(cssVar, `${String(placed.width)}px`)
  }

  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const fromX = event.clientX
    const fromWidth = layout.open ? layout.width : 0
    const space = room()
    let open = layout.open
    let placed = layout
    const move = (next: PointerEvent): void => {
      const delta = side === 'left' ? next.clientX - fromX : fromX - next.clientX
      placed = placeEdge(fromWidth + delta, limits, space, layout.width)
      write(placed)
      if (placed.open !== open) {
        open = placed.open
        onOpenChange(open)
      }
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      onCommit(placed)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const key = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const outward = side === 'left' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft'
    // One step in from the narrowest width closes the panel; one step out opens it at that width.
    const from = layout.open ? layout.width : limits.closeBelow - 1
    const wanted = outward ? Math.max(limits.min, from + KEY_STEP) : from === limits.min ? 0 : from - KEY_STEP
    const placed = placeEdge(wanted, limits, room(), layout.width)
    write(placed)
    onCommit(placed)
  }

  const reset = (): void => {
    const placed = placeEdge(limits.initial, limits, room(), layout.width)
    write(placed)
    onCommit(placed)
  }

  return (
    <div
      className={`panel-resizer is-${side}${layout.open ? '' : ' is-closed'}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={layout.open ? layout.width : 0}
      aria-valuemin={0}
      aria-valuemax={limits.max}
      tabIndex={0}
      {...tip(layout.open ? 'Drag to resize · double-click to reset' : 'Drag to open')}
      onPointerDown={start}
      onDoubleClick={reset}
      onKeyDown={key}
    />
  )
}

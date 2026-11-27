import { useRef, type ReactNode } from 'react'
import { cn } from '../lib/utils'

type Props = {
  /** `row`: panes side by side; `column`: stacked. */
  direction: 'row' | 'column'
  /** The first pane's share, 0–1. */
  value: number
  onChange: (value: number) => void
  /** Double-click or Home/End return here or collapse a pane. */
  initial: number
  label: string
  first: ReactNode
  second: ReactNode
  className?: string
}

const MIN = 0.2
const STEP = 0.05

/**
 * Two panes with a resizable split: a 6 px hit area showing a 1 px line. A separator with its
 * value as a percent; arrow keys move it 5%, Home/End collapse toward a side, double-click resets.
 */
export function Split({ direction, value, onChange, initial, label, first, second, className }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const row = direction === 'row'
  const clamp = (next: number): number => Math.min(1 - MIN, Math.max(MIN, next))
  const template = `minmax(0,${String(value)}fr) 6px minmax(0,${String(1 - value)}fr)`
  return (
    <div
      ref={box}
      className={cn('grid min-h-0 min-w-0', className)}
      style={row ? { gridTemplateColumns: template } : { gridTemplateRows: template }}
    >
      {first}
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        className={cn(
          'split-handle relative focus-visible:outline-2 focus-visible:outline-ring',
          row ? 'cursor-col-resize' : 'cursor-row-resize',
          "after:absolute after:bg-border after:content-[''] hover:after:bg-input",
          row ? 'after:inset-y-0 after:left-[2.5px] after:w-px' : 'after:inset-x-0 after:top-[2.5px] after:h-px'
        )}
        onDoubleClick={() => onChange(initial)}
        onKeyDown={(event) => {
          const back = row ? 'ArrowLeft' : 'ArrowUp'
          const forward = row ? 'ArrowRight' : 'ArrowDown'
          if (event.key === back) onChange(clamp(value - STEP))
          else if (event.key === forward) onChange(clamp(value + STEP))
          else if (event.key === 'Home') onChange(MIN)
          else if (event.key === 'End') onChange(1 - MIN)
          else return
          event.preventDefault()
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const rect = box.current?.getBoundingClientRect()
          if (!rect) return
          const handle = event.currentTarget
          handle.setPointerCapture(event.pointerId)
          const move = (next: PointerEvent): void => {
            const at = row ? (next.clientX - rect.left) / rect.width : (next.clientY - rect.top) / rect.height
            onChange(clamp(at))
          }
          const up = (): void => {
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('pointerup', up)
          }
          handle.addEventListener('pointermove', move)
          handle.addEventListener('pointerup', up)
        }}
      />
      {second}
    </div>
  )
}

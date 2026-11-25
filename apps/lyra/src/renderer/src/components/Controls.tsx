import {
  createElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { radioIndex } from '../lib/focus'
import { CheckIcon, ChevronDownIcon } from './Icons'

type ScrollAreaProps = HTMLAttributes<HTMLElement> & {
  /** The element to render, for semantics (a sidebar `nav`, a listbox `ul`, the panel `aside`). */
  as?: 'div' | 'nav' | 'aside' | 'ul' | 'section'
  /** `y` scrolls vertically (the default); `x` scrolls a strip sideways with its bar hidden. */
  axis?: 'x' | 'y'
  ref?: Ref<HTMLElement>
}

/**
 * Every scrolling region in Lyra: the page, the sidebar, dialogs, panels, menus and popovers.
 * A thin themed bar with no arrow buttons instead of the OS scrollbar, a gutter that doesn't
 * shift content when the bar appears, and scrolling that stops at its edge instead of
 * chaining to the page behind. Never put `overflow: auto` on a component directly.
 */
export function ScrollArea({ as = 'div', axis = 'y', className, ref, ...rest }: ScrollAreaProps) {
  return createElement(as, {
    ...rest,
    ref,
    className: `scroll-area scroll-${axis}${className ? ` ${className}` : ''}`
  })
}

/**
 * Renders a floating layer (menu, popover, toast) at the top of the document. Fixed
 * positioning is relative to the nearest ancestor with a filter, transform or containment
 * (the dock's backdrop blur, the transcript's container query), so anything that floats over
 * the page is portaled out of those and positioned against the window.
 */
export function Floating({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

/**
 * Shared form primitives, so every screen gets the same switch, segmented control and select.
 * Screens never use a native `<select>`: it can't be themed and looks different on each OS.
 */

export type SelectOption<T extends string> = { value: T; label: string; hint?: string }

type SelectProps<T extends string> = {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** Accessible name. */
  label: string
  /** `field` looks like an input (Settings); `ghost` is a quiet inline control (the dock). */
  variant?: 'field' | 'ghost'
  /** Shown before the value, e.g. a microphone icon. */
  icon?: ReactNode
  disabled?: boolean
  className?: string
  /** Called as the list opens (e.g. to refresh devices). */
  onOpen?: () => void
}

/** A themed dropdown: a button that opens a listbox. Arrows, Home/End, Enter, Escape, type-ahead. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  variant = 'field',
  icon,
  disabled = false,
  className,
  onOpen
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<{ top: number; left: number; width: number; up: boolean }>()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const id = useId()
  const selected = options.find((option) => option.value === value)

  const show = (): void => {
    if (disabled) return
    onOpen?.()
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value)
      )
    )
    setOpen(true)
  }
  const close = (refocus: boolean): void => {
    setOpen(false)
    setPlace(undefined)
    if (refocus) button.current?.focus()
  }
  const pick = (index: number): void => {
    const option = options[index]
    if (option) onChange(option.value)
    close(true)
  }

  // First pass: under the button. Second pass, once the list's real size is known: flip above
  // when there's no room below, and keep the right edge inside the window.
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    setPlace({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 200), up: false })
  }, [open])

  useLayoutEffect(() => {
    const node = list.current
    if (!open || !node || !place || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const size = node.getBoundingClientRect()
    const up = rect.bottom + size.height + 8 > window.innerHeight && rect.top > size.height + 8
    const top = up ? rect.top - size.height - 4 : rect.bottom + 4
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8))
    if (top !== place.top || left !== place.left || up !== place.up)
      setPlace({ ...place, top, left, up })
  }, [open, place])

  // Once the list is on screen (it renders after its position is known), move focus into it.
  // preventScroll: focusing a fixed list must not scroll the page behind it.
  const placed = place !== undefined
  useEffect(() => {
    if (open && placed) list.current?.focus({ preventScroll: true })
  }, [open, placed])

  // Keep the highlighted option visible inside the list (never scrolls the page).
  useEffect(() => {
    const node = list.current
    const option = node?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`)
    if (!node || !option) return
    if (option.offsetTop < node.scrollTop) node.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > node.scrollTop + node.clientHeight) {
      node.scrollTop = option.offsetTop + option.offsetHeight - node.clientHeight
    }
  }, [active, open])

  const onListKey = (event: ReactKeyboardEvent): void => {
    const last = options.length - 1
    if (event.key === 'ArrowDown') setActive((i) => Math.min(last, i + 1))
    else if (event.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (event.key === 'Home') setActive(0)
    else if (event.key === 'End') setActive(last)
    else if (event.key === 'Enter' || event.key === ' ') pick(active)
    else if (event.key === 'Escape') close(true)
    else if (event.key === 'Tab') {
      // The list is portaled to the end of the page, so Tab from it would fall off the end.
      // Refocus the button first; the browser then moves on from there as usual.
      close(true)
      return
    } else if (event.key.length === 1) {
      // Type-ahead: jump to the first option starting with what was typed recently.
      const now = Date.now()
      typed.current = {
        text: (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase(),
        at: now
      }
      const match = options.findIndex((option) =>
        option.label.toLowerCase().startsWith(typed.current.text)
      )
      if (match >= 0) setActive(match)
    } else return
    event.preventDefault()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select select-${variant}${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? ''}`}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show()
          }
        }}
      >
        {icon}
        <span className="select-value">{selected?.label ?? ''}</span>
        <ChevronDownIcon />
      </button>
      {open && place ? (
        <Floating>
          <div className="select-layer" onMouseDown={() => close(false)}>
            <ScrollArea
              as="ul"
              ref={list}
              id={id}
              className={`select-list${place.up ? ' up' : ''}`}
              role="listbox"
              aria-label={label}
              aria-activedescendant={`${id}-${String(active)}`}
              tabIndex={-1}
              style={{ top: place.top, left: place.left, minWidth: place.width }}
              onMouseDown={(event) => {
                event.stopPropagation()
              }}
              onKeyDown={onListKey}
            >
              {options.map((option, index) => (
                <li
                  key={option.value}
                  id={`${id}-${String(index)}`}
                  data-index={index}
                  role="option"
                  aria-selected={option.value === value}
                  className={index === active ? 'select-option active' : 'select-option'}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(index)}
                >
                  <span className="select-check" aria-hidden="true">
                    {option.value === value ? <CheckIcon /> : null}
                  </span>
                  <span className="select-label">
                    {option.label}
                    {option.hint ? <small>{option.hint}</small> : null}
                  </span>
                </li>
              ))}
            </ScrollArea>
          </div>
        </Floating>
      ) : null}
    </>
  )
}

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

/** An on/off setting that applies at once. A checkbox underneath, for keyboard and forms. */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => {
        onChange(event.target.checked)
      }}
    />
  )
}

type SegmentedProps<T extends string> = {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
  className?: string
}

/**
 * Two or three exclusive choices, all visible at once (a select hides them). A radio group:
 * one tab stop, and the arrow keys move to and choose the next option.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null)
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    const next = radioIndex(event.key, current, options.length)
    const option = next === null ? undefined : options[next]
    if (next === null || !option) return
    event.preventDefault()
    onChange(option.value)
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <div
      className={className ? `segmented ${className}` : 'segmented'}
      role="radiogroup"
      aria-label={label}
      ref={group}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === current ? 0 : -1}
          onClick={() => {
            onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

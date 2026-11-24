import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { Floating } from './Controls'

export type MenuItem =
  | {
      label: ReactNode
      run: () => void
      /** Shown on the right, e.g. `shortcutLabel('Z')`. */
      shortcut?: string
      icon?: ReactNode
      danger?: boolean
      disabled?: boolean
    }
  | 'separator'

type Runnable = Exclude<MenuItem, 'separator'>

export type MenuRequest = { x: number; y: number; label: string; items: MenuItem[] }

type Props = MenuRequest & { onClose: () => void }

const EDGE = 8

/**
 * Every right-click menu in Lyra: sessions in the sidebar, transcript lines, speakers, tags,
 * people. Arrow keys, Home/End, Enter, Escape; clicking outside or right-clicking again closes
 * it, and focus goes back to where it was.
 */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null)
  const runnable = items.filter((item): item is Runnable => item !== 'separator')
  const enabled = runnable.flatMap((item, index) => (item.disabled ? [] : [index]))
  const [active, setActive] = useState(enabled[0] ?? -1)
  const [place, setPlace] = useState({ top: y, left: x })
  // When any item has an icon, every label lines up after the icon column.
  const iconColumn = runnable.some((item) => item.icon !== undefined)

  // Keep the whole menu inside the window, flipping up or left from the pointer when needed.
  useLayoutEffect(() => {
    const node = menu.current
    if (!node) return
    const size = node.getBoundingClientRect()
    const top = y + size.height + EDGE > window.innerHeight ? y - size.height : y
    const left = x + size.width + EDGE > window.innerWidth ? x - size.width : x
    setPlace({
      top: Math.max(EDGE, Math.min(top, window.innerHeight - size.height - EDGE)),
      left: Math.max(EDGE, Math.min(left, window.innerWidth - size.width - EDGE))
    })
  }, [x, y])

  useEffect(() => {
    const previous = document.activeElement
    menu.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [])

  const pick = (item: Runnable | undefined): void => {
    if (!item || item.disabled) return
    onClose()
    item.run()
  }

  const step = (direction: 1 | -1): void => {
    if (!enabled.length) return
    const at = enabled.indexOf(active)
    const next = at < 0 ? 0 : (at + direction + enabled.length) % enabled.length
    setActive(enabled[next] ?? -1)
  }

  return (
    <Floating>
      <div
        className="menu-layer"
        onMouseDown={(event) => {
          event.stopPropagation()
          onClose()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <div
          ref={menu}
          className="context-menu"
          role="menu"
          tabIndex={-1}
          aria-label={label}
          style={place}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onKeyDown={(event) => {
            const keys: Record<string, () => void> = {
              Escape: onClose,
              Tab: onClose,
              ArrowDown: () => step(1),
              ArrowUp: () => step(-1),
              Home: () => setActive(enabled[0] ?? -1),
              End: () => setActive(enabled.at(-1) ?? -1),
              Enter: () => pick(runnable[active]),
              ' ': () => pick(runnable[active])
            }
            const handler = keys[event.key]
            if (!handler) return
            event.preventDefault()
            event.stopPropagation()
            handler()
          }}
        >
          {items.map((item, index) => {
            if (item === 'separator') return <hr key={`separator-${String(index)}`} />
            const position = runnable.indexOf(item)
            return (
              <button
                key={index}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={[
                  position === active ? 'active' : '',
                  item.danger ? 'danger' : ''
                ].join(' ')}
                onMouseEnter={() => {
                  if (!item.disabled) setActive(position)
                }}
                onClick={() => pick(item)}
              >
                {iconColumn ? (
                  <span className="menu-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className="menu-label">{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              </button>
            )
          })}
        </div>
      </div>
    </Floating>
  )
}

/** Where a menu opened from `event` should appear: the pointer, or the element for the keyboard. */
function pointOf(event: ReactMouseEvent): { x: number; y: number } {
  // The context-menu key and Shift+F10 report (0, 0); open beside the focused element instead.
  if (event.clientX === 0 && event.clientY === 0 && event.currentTarget instanceof Element) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.bottom }
  }
  return { x: event.clientX, y: event.clientY }
}

/**
 * A context menu for a component: `open(event, label, items)` from `onContextMenu`, and render
 * `element`. Only one menu is open at a time per component.
 */
export function useContextMenu(): {
  open: (event: ReactMouseEvent, label: string, items: MenuItem[]) => void
  openAt: (request: MenuRequest) => void
  element: ReactNode
} {
  const [request, setRequest] = useState<MenuRequest | null>(null)
  const close = useCallback(() => setRequest(null), [])
  const open = useCallback((event: ReactMouseEvent, label: string, items: MenuItem[]) => {
    event.preventDefault()
    event.stopPropagation()
    setRequest({ ...pointOf(event), label, items })
  }, [])
  const element = request ? <ContextMenu {...request} onClose={close} /> : null
  return { open, openAt: setRequest, element }
}

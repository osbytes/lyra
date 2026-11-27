import { useCallback, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

export type MenuItem =
  | {
      label: ReactNode
      run: () => void
      /** Shown on the right, e.g. `shortcutLabel('Z')`. */
      shortcut?: string
      /** Every item has one, so labels line up and the menu can be scanned by shape. */
      icon: ReactNode
      danger?: boolean
      disabled?: boolean
    }
  | {
      label: ReactNode
      /**
       * Swaps the menu for these items in place ("Send to…" → the apps), rather than opening
       * a submenu beside it, which a menu near the window's edge has no room for.
       */
      next: MenuPage
      icon: ReactNode
    }
  /** A small caps heading over the items after it. */
  | { heading: string }
  | 'separator'

/** A menu's items; or, for a page with its own state (checkboxes), a component that draws them. */
export type MenuPage = { label: string; items: MenuItem[] } | { label: string; content: ReactNode }

export type MenuRequest = { x: number; y: number; label: string; items: MenuItem[] }

type Props = MenuRequest & { onClose: () => void }

/**
 * Every right-click menu in Lyra: sessions in the sidebar, transcript lines, speakers, tags,
 * people. A Radix menu anchored at the pointer: arrow keys, Home/End, type-ahead, Enter, Escape;
 * clicking outside closes it, and focus goes back to where it was.
 */
export function ContextMenu({ x, y, label: firstLabel, items: firstItems, onClose }: Props) {
  const [page, setPage] = useState<MenuPage | null>(null)
  const shown = page ?? { label: firstLabel, items: firstItems }
  const { label } = shown
  const items = 'items' in shown ? shown.items : []
  // When any item has an icon, every label lines up after the icon column.
  const iconColumn = items.some((item) => item !== 'separator' && 'label' in item && item.icon !== undefined)
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed size-0"
          style={{ left: x, top: y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="context-menu"
        aria-label={label}
        align="start"
        side="bottom"
        sideOffset={2}
        collisionPadding={8}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      >
        {'content' in shown ? shown.content : null}
        {items.map((item, index) => {
          if (item === 'separator') return <DropdownMenuSeparator key={`separator-${String(index)}`} />
          if ('heading' in item) return <DropdownMenuLabel key={`heading-${String(index)}`}>{item.heading}</DropdownMenuLabel>
          const next = 'next' in item ? item.next : null
          return (
            <DropdownMenuItem
              key={`${label}-${String(index)}`}
              danger={'danger' in item ? (item.danger ?? false) : false}
              disabled={'disabled' in item ? (item.disabled ?? false) : false}
              onSelect={(event) => {
                if (next) {
                  // Keep the menu open on its next page.
                  event.preventDefault()
                  setPage(next)
                } else if ('run' in item) {
                  item.run()
                }
              }}
            >
              {iconColumn ? (
                <span className="grid size-4 place-items-center" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {'shortcut' in item && item.shortcut ? <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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

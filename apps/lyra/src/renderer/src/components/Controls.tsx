import { createElement, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/utils'
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select'
import { Switch as SwitchRoot } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

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

/** A themed dropdown (Radix Select): arrows, Home/End, Enter, Escape and type-ahead. */
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
  const selected = options.find((option) => option.value === value)
  return (
    <SelectRoot
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next)
        if (option) onChange(option.value)
      }}
      onOpenChange={(open) => {
        if (open) onOpen?.()
      }}
    >
      <SelectTrigger
        variant={variant}
        className={cn('select', `select-${variant}`, className)}
        aria-label={`${label}: ${selected?.label ?? ''}`}
      >
        {icon}
        <SelectValue />
      </SelectTrigger>
      <SelectContent aria-label={label}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} hint={option.hint}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

/** An on/off setting that applies at once. */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <SwitchRoot checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
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
 * one tab stop, and the arrow keys move between the options.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className
}: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      role="radiogroup"
      aria-label={label}
      className={cn('segmented', className)}
      onValueChange={(next) => {
        // Radix clears the value when the chosen option is pressed again; a segment stays chosen.
        const option = options.find((candidate) => candidate.value === next)
        if (option) onChange(option.value)
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} role="radio" aria-checked={option.value === value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

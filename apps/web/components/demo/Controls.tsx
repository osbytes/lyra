// The app's form and layout primitives (apps/lyra/src/renderer/src/components/Controls.tsx),
// trimmed to what the demo uses.
import { createElement, type HTMLAttributes, type Ref } from 'react'

type ScrollAreaProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'nav' | 'aside' | 'ul' | 'section'
  axis?: 'x' | 'y'
  ref?: Ref<HTMLElement>
}

/** A scrolling region with the app's thin themed scrollbar. */
export function ScrollArea({ as = 'div', axis = 'y', className, ref, ...rest }: ScrollAreaProps) {
  return createElement(as, {
    ...rest,
    ref,
    className: `scroll-area scroll-${axis}${className ? ` ${className}` : ''}`
  })
}

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
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
}

export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
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

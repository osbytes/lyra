/** Shared form primitives, so every screen gets the same switch and segmented control. */

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
}

/** Two or three exclusive choices, all visible at once (a select hides them). */
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

import { useMicrophones } from '../hooks/useMicrophones'

type Props = {
  value: string | null
  onChange: (deviceId: string | null) => void
  disabled?: boolean
  className?: string
}

const DEFAULT = ''

/** Picks an input device; the empty option means "follow the system default". */
export function MicrophoneSelect({ value, onChange, disabled = false, className }: Props) {
  const { microphones, refresh } = useMicrophones()
  const missing =
    value !== null && !microphones.some((mic) => mic.deviceId === value) ? value : null

  return (
    <select
      className={className ?? 'settings-select'}
      value={value ?? DEFAULT}
      disabled={disabled}
      aria-label="Microphone"
      onFocus={() => void refresh()}
      onChange={(event) => {
        onChange(event.target.value === DEFAULT ? null : event.target.value)
      }}
    >
      <option value={DEFAULT}>System default</option>
      {microphones.map((mic) => (
        <option key={mic.deviceId} value={mic.deviceId}>
          {mic.label}
        </option>
      ))}
      {missing === null ? null : <option value={missing}>Unavailable microphone</option>}
    </select>
  )
}

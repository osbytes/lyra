import { useMicrophones } from '../hooks/useMicrophones'
import { Select, type SelectOption } from './Controls'
import { MicSmallIcon } from './Icons'

type Props = {
  value: string | null
  onChange: (deviceId: string | null) => void
  disabled?: boolean
  /** `ghost` for the dock, `field` for Settings. */
  variant?: 'field' | 'ghost'
}

// Not a real deviceId: Chromium's own "default" pseudo-device is filtered out of the list.
const DEFAULT = '__system_default__'

/** Picks an input device; "System default" follows the OS choice. */
export function MicrophoneSelect({ value, onChange, disabled = false, variant = 'field' }: Props) {
  const { microphones, refresh } = useMicrophones()
  const options: SelectOption<string>[] = [
    { value: DEFAULT, label: 'System default' },
    ...microphones.map((mic) => ({ value: mic.deviceId, label: mic.label }))
  ]
  if (value !== null && !microphones.some((mic) => mic.deviceId === value)) {
    options.push({ value, label: 'Unavailable microphone', hint: 'Plug it back in, or pick another' })
  }

  return (
    <Select
      label="Microphone"
      variant={variant}
      icon={variant === 'ghost' ? <MicSmallIcon /> : undefined}
      value={value ?? DEFAULT}
      options={options}
      disabled={disabled}
      onOpen={() => void refresh()}
      onChange={(next) => {
        onChange(next === DEFAULT ? null : next)
      }}
    />
  )
}

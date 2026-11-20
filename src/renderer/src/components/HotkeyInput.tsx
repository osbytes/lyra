import { useState, type KeyboardEvent } from 'react'
import { isMac } from '../lib/format'

type Props = {
  value: string
  onChange: (accelerator: string) => void
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock'])

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
}

/** The non-modifier part of an Electron accelerator, from the physical key pressed. */
function keyName(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const named = NAMED_KEYS[event.key]
  if (named) return named
  if (/^F\d{1,2}$/.test(event.key)) return event.key
  // \`code\` ignores layout and Shift ("KeyA", "Digit1"), which is what accelerators expect.
  const code = /^(?:Key|Digit)(.)$/.exec(event.code)?.[1]
  return code ?? null
}

/** Converts a key press into an Electron accelerator, or null if it isn't a usable shortcut. */
export function toAccelerator(event: KeyboardEvent): string | null {
  const key = keyName(event)
  if (!key) return null
  const parts: string[] = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('CommandOrControl')
  if (isMac && event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  // A global shortcut without a modifier would swallow that key in every app.
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'Shift')) return null
  return [...parts, key].join('+')
}

/** Shows an accelerator the way the platform writes shortcuts. */
export function displayAccelerator(accelerator: string): string {
  if (!accelerator) return 'None'
  const parts = accelerator.split('+').map((part) => {
    if (part === 'CommandOrControl' || part === 'CmdOrCtrl') return isMac ? '⌘' : 'Ctrl'
    if (isMac && part === 'Control') return '⌃'
    if (isMac && part === 'Alt') return '⌥'
    if (isMac && part === 'Shift') return '⇧'
    return part
  })
  return parts.join(isMac ? '' : '+')
}

export function HotkeyInput({ value, onChange }: Props) {
  const [recording, setRecording] = useState(false)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      return
    }
    const accelerator = toAccelerator(event)
    if (!accelerator) return
    setRecording(false)
    onChange(accelerator)
  }

  return (
    <button
      type="button"
      className={`hotkey-input${recording ? ' is-recording' : ''}`}
      onClick={() => {
        setRecording(true)
      }}
      onBlur={() => {
        setRecording(false)
      }}
      onKeyDown={onKeyDown}
      aria-label="Change shortcut"
    >
      {recording ? 'Press a shortcut…' : displayAccelerator(value)}
    </button>
  )
}

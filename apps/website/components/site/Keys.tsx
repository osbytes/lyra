'use client'

import { keyLabel, useOs } from '@/lib/platform'

type Props = {
  /** Keys joined with `+`, e.g. `Mod+Shift+Space`. `Mod` is ⌘ on macOS and Ctrl elsewhere. */
  combo: string
  className?: string
}

/** A shortcut as keycaps for the visitor's OS. */
export function Keys({ combo, className }: Props) {
  const os = useOs()
  return (
    <span className={className}>
      {combo.split('+').map((key) => (
        <kbd key={key}>{keyLabel(os, key)}</kbd>
      ))}
    </span>
  )
}

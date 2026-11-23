import { useSyncExternalStore } from 'react'

export type Os = 'mac' | 'windows' | 'linux'

export function detectOs(userAgent: string): Os {
  if (userAgent.includes('Windows')) return 'windows'
  if (/Mac|iPhone|iPad/.test(userAgent)) return 'mac'
  if (/Linux|X11|Android|CrOS/.test(userAgent)) return 'linux'
  return 'mac'
}

const subscribeNever = (): (() => void) => () => undefined

/**
 * The visitor's OS. The server can't know it, so the static HTML is rendered for macOS and the
 * client switches after hydration.
 */
export function useOs(): Os {
  return useSyncExternalStore(
    subscribeNever,
    () => detectOs(navigator.userAgent),
    () => 'mac'
  )
}

const PHONE_OR_TABLET = /Android|iPhone|iPad|iPod|Mobile/

/**
 * The desktop OS to offer a download for; null on a phone or tablet, where Lyra doesn't run.
 * Rendered for macOS on the server, like useOs.
 */
export function useDesktopOs(): Os | null {
  return useSyncExternalStore(
    subscribeNever,
    () => (PHONE_OR_TABLET.test(navigator.userAgent) ? null : detectOs(navigator.userAgent)),
    () => 'mac'
  )
}

/** One key of a combo like `Mod+Shift+Space`, as printed on that OS's keyboard. */
export function keyLabel(os: Os, key: string): string {
  if (key === 'Mod') return os === 'mac' ? '⌘' : 'Ctrl'
  if (key === 'Shift') return os === 'mac' ? '⇧' : 'Shift'
  return key
}

/** The app's own shortcut format (lib/format.ts `shortcutLabel`): `⇧⌘D` or `Ctrl+Shift+D`. */
export function shortcutLabel(os: Os, key: string, shift = false): string {
  return os === 'mac' ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => {
        list.removeEventListener('change', onChange)
      }
    },
    () => matchMedia(query).matches,
    () => false
  )
}

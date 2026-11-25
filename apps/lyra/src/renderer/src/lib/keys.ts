/** Keys whose names differ between macOS and Windows/Linux. */
export type NamedKey = 'Enter' | 'Shift+Enter' | 'Esc' | 'Delete'

/**
 * How a key is written on this platform: macOS uses symbols (and deletes with ⌘⌫, since its
 * Delete key is a backspace), Windows and Linux spell names out.
 */
export function keyName(key: NamedKey, mac: boolean): string {
  switch (key) {
    case 'Enter':
      return mac ? '↩' : 'Enter'
    case 'Shift+Enter':
      return mac ? '⇧↩' : 'Shift+Enter'
    case 'Esc':
      return 'Esc'
    case 'Delete':
      return mac ? '⌘⌫' : 'Del'
  }
}

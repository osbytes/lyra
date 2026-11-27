import { useSyncExternalStore } from 'react'

/**
 * Comfortable or compact: an explicit preference that tightens rows and controls in this
 * window's chrome. It never shrinks reading type. Kept per window in local storage, like the
 * library's sort, since it's about this screen rather than the notes.
 */
export type Density = 'comfortable' | 'compact'

const KEY = 'lyra.density'
const listeners = new Set<() => void>()

function read(): Density {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

export function setDensity(next: Density): void {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Storage can be unavailable; the choice then lasts until the window closes.
  }
  document.documentElement.dataset.density = next
  for (const listener of listeners) listener()
}

/** Applies the stored density to the document once at startup (for CSS that keys off it). */
export function applyDensity(): void {
  document.documentElement.dataset.density = read()
}

export function useDensity(): Density {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read
  )
}

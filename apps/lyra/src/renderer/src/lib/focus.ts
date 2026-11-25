/**
 * Where Tab should land in a focus trap of `count` elements when focus is at `index` (-1 when it
 * is outside the list). Wraps at both ends. `null` means there is nothing focusable inside, so
 * focus should stay on the container.
 */
export function nextTrapIndex(index: number, count: number, backwards: boolean): number | null {
  if (count === 0) return null
  if (index < 0) return backwards ? count - 1 : 0
  if (backwards) return index === 0 ? count - 1 : index - 1
  return index === count - 1 ? 0 : index + 1
}

/**
 * Roving focus in a list of `count` items: the index a navigation key moves to from `index`, or
 * `null` when the key isn't a list navigation key. Doesn't wrap, like a native listbox.
 */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  const last = count - 1
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, Math.max(0, index + 1))
    case 'ArrowUp':
      return Math.max(0, Math.min(last, index - 1))
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/**
 * Arrow-key movement for a radio group: wraps, and Left/Up go back, Right/Down go forward, as
 * the ARIA radio group pattern specifies.
 */
export function radioIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

import { useSyncExternalStore } from 'react'

/**
 * The window grid (interface system, Space): compact 320–559 is one column with tabs; medium
 * 560–899 is the session alone with the library as a drawer and the panes stacked; wide
 * 900–1279 is library and two panes side by side; full ≥ 1280 adds a third pane.
 */
export type WidthClass = 'compact' | 'medium' | 'wide' | 'full'

const QUERIES: [WidthClass, string][] = [
  ['compact', '(max-width: 559px)'],
  ['medium', '(max-width: 899px)'],
  ['wide', '(max-width: 1279px)']
]

function read(): WidthClass {
  for (const [name, query] of QUERIES) if (window.matchMedia(query).matches) return name
  return 'full'
}

export function useWidthClass(): WidthClass {
  return useSyncExternalStore((listener) => {
    const lists = QUERIES.map(([, query]) => window.matchMedia(query))
    for (const list of lists) list.addEventListener('change', listener)
    return () => {
      for (const list of lists) list.removeEventListener('change', listener)
    }
  }, read)
}

import { useEffect, useState } from 'react'
import type { SearchHit } from '../../../shared/types'
import { log } from '../lib/log'

/** Waits for a pause in typing, so each keystroke doesn't read every note. */
const SEARCH_DEBOUNCE_MS = 120

export type SearchState = { query: string; hits: SearchHit[]; pending: boolean }

/** Full-text search across sessions in main, debounced; stale answers are dropped. */
export function useSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>({ query: '', hits: [], pending: false })

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setState({ query: '', hits: [], pending: false })
      return
    }
    setState((previous) => ({ ...previous, pending: true }))
    let cancelled = false
    const timer = setTimeout(() => {
      window.api
        .searchPages(needle)
        .then((hits) => {
          if (!cancelled) setState({ query: needle, hits, pending: false })
        })
        .catch((error: unknown) => {
          log('search', 'search failed', { error: error instanceof Error ? error.message : String(error) })
          if (!cancelled) setState({ query: needle, hits: [], pending: false })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return state
}

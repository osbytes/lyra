import { useCallback, useEffect, useState } from 'react'
import type { PeopleActivity } from '../../../shared/peopleActivity'
import type { PageSummary, Person } from '../../../shared/types'
import { log } from '../lib/log'

export type PeopleActivityState =
  | { state: 'loading' }
  | { state: 'ready'; activity: PeopleActivity }
  | { state: 'failed'; retry: () => void }

/**
 * Who spoke in which session, read again whenever the library or the saved people change (a
 * renamed speaker, a new meeting), so the numbers follow the notes.
 */
export function usePeopleActivity(pages: readonly PageSummary[], people: readonly Person[]): PeopleActivityState {
  const [result, setResult] = useState<PeopleActivityState>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setResult({ state: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.peopleActivity().then(
      (activity) => {
        if (!cancelled) setResult({ state: 'ready', activity })
      },
      (error: unknown) => {
        log('people', 'could not read people activity', error instanceof Error ? error.message : String(error))
        if (!cancelled) setResult({ state: 'failed', retry })
      }
    )
    return () => {
      cancelled = true
    }
  }, [pages, people, attempt, retry])

  return result
}

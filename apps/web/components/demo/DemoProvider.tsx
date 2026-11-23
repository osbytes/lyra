'use client'

import { createContext, use, useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { ExportContext } from '@/lib/demo/export'
import { reducer, type Action } from '@/lib/demo/reducer'
import { initialState } from '@/lib/demo/seed'
import type { DemoState, Session } from '@/lib/demo/types'

type DemoValue = {
  state: DemoState
  current: Session
  /** What the exporters need, for summaries, exports and word counts. */
  exportContext: ExportContext
  dispatch: (action: Action) => void
}

const DemoContext = createContext<DemoValue | null>(null)

type Props = {
  /** When the page was rendered. The demo's sessions are dated relative to it. */
  now: number
  children: ReactNode
}

/**
 * The demo's one store, shared by the app window, the meeting card and the files view, so
 * naming a speaker or dictating a note shows up everywhere. Its clock starts at the page's render
 * time and runs from when the page loaded, so the server and the browser draw the same dates.
 */
export function DemoProvider({ now, children }: Props) {
  const [state, dispatchStamped] = useReducer(reducer, now, initialState)
  const loadedAt = useRef<number | null>(null)

  useEffect(() => {
    loadedAt.current = Date.now()
  }, [])

  const dispatch = useCallback(
    (action: Action) => {
      const elapsed = loadedAt.current === null ? 0 : Date.now() - loadedAt.current
      dispatchStamped({ ...action, at: now + elapsed })
    },
    [now]
  )

  // Keeps "Edited 2m ago" and the day groups current.
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: 'tick' })
    }, 30_000)
    return () => {
      clearInterval(timer)
    }
  }, [dispatch])

  const value = useMemo((): DemoValue => {
    const current = state.sessions.find((session) => session.id === state.currentId) ?? state.sessions[0]
    if (!current) throw new Error('The demo always has at least one session')
    return {
      state,
      current,
      exportContext: {
        speakers: state.speakers,
        lines: state.lines,
        doneActions: state.doneActions,
        settings: state.settings
      },
      dispatch
    }
  }, [state, dispatch])

  return <DemoContext value={value}>{children}</DemoContext>
}

export function useDemo(): DemoValue {
  const value = use(DemoContext)
  if (!value) throw new Error('useDemo must be used inside a DemoProvider')
  return value
}

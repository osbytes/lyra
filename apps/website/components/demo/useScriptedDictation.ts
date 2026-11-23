'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { beat, flush, scriptFor, START, type Cursor, type ScriptStep } from '@/lib/demo/dictation'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

type Callbacks = {
  /** Recording starts: the transcriber's cursor goes to the end of the page. */
  onBegin: () => void
  /** Confirmed words to write at the transcriber's cursor. */
  onCommit: (chunk: string) => void
  /** Recording stopped after `seconds`. */
  onEnd: (seconds: number) => void
}

type Run = {
  script: readonly ScriptStep[]
  cursor: Cursor | null
  talking: boolean
  level: number
  startedAt: number
  timers: ReturnType<typeof setTimeout>[]
  meter: ReturnType<typeof setInterval> | null
}

type LevelListener = (level: number) => void

const WARM_UP_MS = 550
const FINISH_MS = 450

/**
 * Drives the demo's scripted voice with the same phases as the app's useDictation: warming up,
 * listening (ghost words firm up and are written), finishing up. The level meter is published
 * through `subscribeLevel` so the waveform redraws without re-rendering React.
 */
export function useScriptedDictation(callbacks: Callbacks) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [ghost, setGhost] = useState('')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const latest = useRef(callbacks)
  const run = useRef<Run | null>(null)
  const listeners = useRef(new Set<LevelListener>())
  const finishing = useRef<ReturnType<typeof setTimeout> | null>(null)
  // `step` runs before `stop` exists; it reaches it through this ref when the script ends.
  const stopRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    latest.current = callbacks
  })

  const clear = useCallback((current: Run) => {
    current.timers.forEach(clearTimeout)
    current.timers = []
    if (current.meter) clearInterval(current.meter)
    current.meter = null
  }, [])

  const step = useCallback(() => {
    const current = run.current
    if (!current?.cursor) return
    const next = beat(current.script, current.cursor, Math.random)
    if (next.commit) latest.current.onCommit(next.commit)
    setGhost(next.ghost)
    current.talking = next.talking
    current.cursor = next.next
    // When the script runs out, recording stops on its own, as if the speaker pressed stop.
    current.timers.push(next.next ? setTimeout(step, next.delay) : setTimeout(() => stopRef.current(), 700))
  }, [])

  const stop = useCallback(() => {
    const current = run.current
    if (!current) return
    clear(current)
    const rest = current.cursor ? flush(current.script, current.cursor) : ''
    if (rest) latest.current.onCommit(rest)
    run.current = null
    setGhost('')
    setStartedAt(null)
    listeners.current.forEach((listener) => {
      listener(0)
    })
    latest.current.onEnd(Math.round((Date.now() - current.startedAt) / 1000))
    setPhase('finishing')
    finishing.current = setTimeout(() => {
      setPhase('idle')
    }, FINISH_MS)
  }, [clear])

  const start = useCallback(
    (pageHasText: boolean) => {
      if (run.current) return
      if (finishing.current) clearTimeout(finishing.current)
      const current: Run = {
        script: scriptFor(pageHasText),
        cursor: START,
        talking: false,
        level: 0,
        startedAt: Date.now(),
        timers: [],
        meter: null
      }
      run.current = current
      latest.current.onBegin()
      setPhase('starting')
      current.timers.push(
        setTimeout(() => {
          current.startedAt = Date.now()
          setStartedAt(current.startedAt)
          setPhase('listening')
          current.meter = setInterval(() => {
            const target = current.talking ? 0.3 + Math.random() * 0.55 : 0.02 + Math.random() * 0.04
            current.level += (target - current.level) * 0.45
            listeners.current.forEach((listener) => {
              listener(current.level)
            })
          }, 40)
          step()
        }, WARM_UP_MS)
      )
    },
    [step]
  )

  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  useEffect(
    () => () => {
      if (run.current) clear(run.current)
      if (finishing.current) clearTimeout(finishing.current)
    },
    [clear]
  )

  const subscribeLevel = useCallback((listener: LevelListener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return { phase, ghost, startedAt, start, stop, subscribeLevel }
}

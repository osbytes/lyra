import { useEffect, useMemo, useState } from 'react'
import { visibleActivity, type ActivityItem } from '../../../shared/activity'
import { log } from '../lib/log'

/**
 * Activity as main holds it (docs/STATES.md), and what of it shows now. Ticks once a second
 * while there's anything in it, so work crossing the 3 s mark appears and seen endings go.
 */
export function useActivity(): { items: ActivityItem[]; visible: ActivityItem[] } {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let alive = true
    let heard = false
    const unsubscribe = window.api.onActivity((next) => {
      heard = true
      setItems(next)
      setNow(Date.now())
    })
    window.api.activityList().then(
      (list) => {
        // An event that arrived first is newer than this answer.
        if (alive && !heard) setItems(list)
      },
      (error: unknown) => {
        log('activity', 'could not read activity', String(error))
      }
    )
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    if (!items.length) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [items.length])
  const visible = useMemo(() => visibleActivity(items, now), [items, now])
  return { items, visible }
}

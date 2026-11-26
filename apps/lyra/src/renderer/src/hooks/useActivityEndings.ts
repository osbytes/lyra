import { useEffect, useRef } from 'react'
import { newEndings, type ActivityItem } from '../../../shared/activity'
import { log } from '../lib/log'

/**
 * Endings, the quiet way (docs/STATES.md): an ending whose screen is open is already seen; one
 * whose screen isn't gets one toast (`announce`). Either way it's marked seen, so a done row
 * leaves Activity a moment later. A failure stays in Activity whatever happens here.
 */
export function useActivityEndings(
  items: readonly ActivityItem[],
  isOpen: (item: ActivityItem) => boolean,
  announce: (item: ActivityItem) => void
): void {
  const before = useRef(new Map<string, ActivityItem>())
  const isOpenRef = useRef(isOpen)
  const announceRef = useRef(announce)
  isOpenRef.current = isOpen
  announceRef.current = announce
  useEffect(() => {
    const endings = newEndings(before.current, items)
    before.current = new Map(items.map((item) => [item.id, item]))
    const seen = new Set<string>()
    for (const item of endings) {
      // Updates are offers, not news: their row says what to do.
      if (!isOpenRef.current(item) && item.kind !== 'update') announceRef.current(item)
      seen.add(item.id)
    }
    // An ending you come back to (its session or Settings opened) is seen too.
    for (const item of items) {
      const ended = item.state !== 'running' && item.state !== 'waiting'
      if (ended && item.seenAt === null && isOpenRef.current(item)) seen.add(item.id)
    }
    if (!seen.size) return
    window.api.markActivitySeen([...seen]).catch((error: unknown) => {
      log('activity', 'could not mark seen', String(error))
    })
  }, [items])
}

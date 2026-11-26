import { useEffect, useState } from 'react'
import type { ModelFeature, ModelStatus } from '../../../shared/types'

/**
 * Where `feature`'s model stands (downloading, reading sessions, ready, failed), kept current
 * from main. Null until main has anything to say about it.
 */
export function useModelStatus(feature: ModelFeature): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  useEffect(() => {
    let alive = true
    let heard = false
    const unsubscribe = window.api.onModelStatus((next) => {
      if (next.feature !== feature) return
      heard = true
      setStatus(next)
    })
    window.api.modelStatus().then(
      (all) => {
        // An event that arrived first is newer than this answer.
        if (!alive || heard) return
        setStatus(all.find((entry) => entry.feature === feature) ?? null)
      },
      () => {
        // Unknown is shown as nothing, as before this line existed.
      }
    )
    return () => {
      alive = false
      unsubscribe()
    }
  }, [feature])
  return status
}

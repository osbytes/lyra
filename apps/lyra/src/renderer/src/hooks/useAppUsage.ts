import { useEffect, useState } from 'react'
import type { AppUsage } from '../../../shared/types'
import { log } from '../lib/log'

/** Main samples every 5 seconds; reading as often keeps the graphs current without waste. */
const POLL_MS = 5000

/** Lyra's CPU and memory over the last 30 minutes, refreshed while the caller is mounted. */
export function useAppUsage(): AppUsage | null {
  const [usage, setUsage] = useState<AppUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const next = await window.api.getAppUsage()
        if (!cancelled) setUsage(next)
      } catch (error) {
        log('settings', 'could not read app usage', String(error))
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return usage
}

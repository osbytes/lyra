import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'

/** The app settings, kept in sync with main. `null` until loaded. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getSettings().then((value) => {
      if (alive) setSettings(value)
    })
    const stop = window.api.onSettingsChanged(setSettings)
    return () => {
      alive = false
      stop()
    }
  }, [])

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.api.updateSettings(patch)
    setSettings(next)
    return next
  }, [])

  return { settings, update }
}

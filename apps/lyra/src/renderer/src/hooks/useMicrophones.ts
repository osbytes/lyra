import { useCallback, useEffect, useState } from 'react'
import { log } from '../lib/log'

export type Microphone = { deviceId: string; label: string }

/**
 * The audio inputs the system reports, kept current as devices are plugged in
 * or removed. Labels are empty until microphone permission has been granted once.
 */
export function useMicrophones(): { microphones: Microphone[]; refresh: () => Promise<void> } {
  const [microphones, setMicrophones] = useState<Microphone[]>([])

  const refresh = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter(
        (device) =>
          device.kind === 'audioinput' &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications'
      )
      setMicrophones(
        inputs.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`
        }))
      )
    } catch (error) {
      log('capture', 'could not list microphones', String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = (): void => {
      void refresh()
    }
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange)
    }
  }, [refresh])

  return { microphones, refresh }
}

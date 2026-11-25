import { useEffect, useState } from 'react'
import type { PermissionStatus } from '../../../shared/types'

/**
 * Whether the OS lets Lyra use the microphone and capture the screen, asked again whenever the
 * window regains focus: the user usually changes it in System Settings and comes back. Null
 * until known. Asked locally; nothing here prompts.
 */
export function usePermissions(): PermissionStatus | null {
  const [status, setStatus] = useState<PermissionStatus | null>(null)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      window.api.permissionStatus().then(
        (next) => {
          if (alive) setStatus(next)
        },
        () => {
          // Unknown is shown as nothing: Settings then just doesn't show the rows.
        }
      )
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [])
  return status
}

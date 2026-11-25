import { shell, systemPreferences } from 'electron'
import type { PermissionKind, PermissionState, PermissionStatus } from '../shared/types'
import { log } from './log'
import { permissionPane } from './permissionPanes'

/**
 * Whether the OS lets Lyra use the microphone and capture the screen (macOS needs Screen
 * Recording for computer audio). Asked locally; nothing here prompts the user.
 */

function mediaStatus(kind: PermissionKind): PermissionState {
  const media = kind === 'microphone' ? 'microphone' : 'screen'
  try {
    return systemPreferences.getMediaAccessStatus(media)
  } catch {
    return 'unknown'
  }
}

export function permissionStatus(): PermissionStatus {
  if (process.platform === 'darwin') {
    return { microphone: mediaStatus('microphone'), screen: mediaStatus('screen') }
  }
  // Windows has a microphone switch but no screen-capture permission; Linux asks for neither.
  if (process.platform === 'win32') return { microphone: mediaStatus('microphone'), screen: 'granted' }
  return { microphone: 'granted', screen: 'granted' }
}

/** Opens the system settings page for `kind`; false when this platform has none. */
export async function openPermissionSettings(kind: PermissionKind): Promise<boolean> {
  const pane = permissionPane(process.platform, kind)
  if (pane === null) return false
  log('permissions', 'opening system settings', { kind })
  await shell.openExternal(pane)
  return true
}

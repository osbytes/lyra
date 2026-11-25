import type { PermissionKind } from '../shared/types'

/**
 * The system settings page for each permission Lyra needs, per platform. A fixed list: the
 * renderer names a permission, never a URL, so it can't get main to open anything else.
 */
const PANES: Partial<Record<NodeJS.Platform, Partial<Record<PermissionKind, string>>>> = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  },
  // Windows has no screen-capture permission; loopback audio needs none.
  win32: { microphone: 'ms-settings:privacy-microphone' }
}

/** The settings page for `kind` on `platform`, or null when it has none to open. */
export function permissionPane(platform: NodeJS.Platform, kind: PermissionKind): string | null {
  return PANES[platform]?.[kind] ?? null
}

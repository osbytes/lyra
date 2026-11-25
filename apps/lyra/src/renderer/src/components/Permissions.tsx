import type { PermissionKind, PermissionState, PermissionStatus } from '../../../shared/types'
import { notify } from '../lib/toast'
import { Row } from './SettingsParts'

const WHAT: Record<PermissionKind, { label: string; mac: string; win: string }> = {
  microphone: {
    label: 'Microphone access',
    mac: 'Allowed in System Settings → Privacy & Security → Microphone.',
    win: 'Allowed in Windows Settings → Privacy & security → Microphone.'
  },
  screen: {
    label: 'Screen Recording access',
    mac: 'macOS asks for it to record computer audio. Allowed in System Settings → Privacy & Security → Screen & System Audio Recording.',
    win: ''
  }
}

function stateText(state: PermissionState): string {
  switch (state) {
    case 'granted':
      return 'Allowed'
    case 'denied':
      return 'Not allowed'
    case 'restricted':
      return 'Blocked by your administrator'
    case 'not-determined':
      return 'Not asked yet'
    case 'unknown':
      return 'Unknown'
  }
}

/** Platforms whose settings have a page for `kind` (main keeps the same list). */
function hasPane(platform: string, kind: PermissionKind): boolean {
  return platform === 'darwin' || (platform === 'win32' && kind === 'microphone')
}

/**
 * A permission's state and a button to its system settings page, on the platforms that have
 * one. Flagged only when the OS refuses it: "not asked yet" is normal before the first recording.
 */
export function PermissionRow({ kind, status }: { kind: PermissionKind; status: PermissionStatus | null }) {
  const platform = window.api.platform
  if (status === null || !hasPane(platform, kind)) return null
  const state = status[kind]
  const refused = state === 'denied' || state === 'restricted'
  const what = WHAT[kind]
  const open = (): void => {
    window.api.openPermissionSettings(kind).then(
      (opened) => {
        if (!opened) notify('Open your system settings to change this.')
      },
      () => {
        notify('Couldn’t open system settings.')
      }
    )
  }
  return (
    <div className={refused ? 'settings-group has-issue' : 'settings-group'}>
      <Row label={what.label} hint={platform === 'darwin' ? what.mac : what.win}>
        <span className={refused ? 'settings-status is-refused' : 'settings-status'}>{stateText(state)}</span>
        <button className="btn" type="button" onClick={open}>
          Open Settings
        </button>
      </Row>
    </div>
  )
}

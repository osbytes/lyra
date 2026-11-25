import { describe, expect, it } from 'vitest'
import { permissionPane } from './permissionPanes'

describe('permissionPane', () => {
  it('names the privacy pages on macOS', () => {
    expect(permissionPane('darwin', 'microphone')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    expect(permissionPane('darwin', 'screen')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  })

  it('has only the microphone page on Windows and nothing elsewhere', () => {
    expect(permissionPane('win32', 'microphone')).toBe('ms-settings:privacy-microphone')
    expect(permissionPane('win32', 'screen')).toBeNull()
    expect(permissionPane('linux', 'microphone')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipcError'

describe('ipcErrorMessage', () => {
  it('cuts Electron’s wrapper off a rejected invoke', () => {
    const error = new Error(
      "Error invoking remote method 'settings:pickFolder': Error: Stop the recording before changing the sessions folder."
    )
    expect(ipcErrorMessage(error)).toBe('Stop the recording before changing the sessions folder.')
  })

  it('keeps a plain message and falls back when there is none', () => {
    expect(ipcErrorMessage(new Error('Disk full'))).toBe('Disk full')
    expect(ipcErrorMessage(undefined, 'Nope')).toBe('Nope')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x:y': Error: "), 'Nope')).toBe('Nope')
  })
})

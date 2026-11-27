import { describe, expect, it } from 'vitest'
import { shortDeviceName } from './deviceName'

describe('shortDeviceName', () => {
  it('drops the default prefix and the USB id', () => {
    expect(shortDeviceName('Default - Microphone (USB Live Camera audio) (0c45:6536)')).toBe(
      'Microphone (USB Live Camera audio)'
    )
    expect(shortDeviceName('Communications - Headset (Jabra Evolve2)')).toBe('Headset (Jabra Evolve2)')
  })

  it('leaves an ordinary name alone', () => {
    expect(shortDeviceName('MacBook Pro Microphone')).toBe('MacBook Pro Microphone')
  })

  it('never returns an empty name', () => {
    expect(shortDeviceName('Default - ')).toBe('Default - ')
  })
})

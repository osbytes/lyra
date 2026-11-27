import { describe, expect, it } from 'vitest'
import { systemAudioSource } from './systemAudioSource'

describe('systemAudioSource', () => {
  it('uses process loopback on Windows builds that have it', () => {
    expect(systemAudioSource('win32', '10.0.22631')).toBe('loopbackWithoutChrome')
    expect(systemAudioSource('win32', '10.0.20348')).toBe('loopbackWithoutChrome')
  })

  it('keeps device loopback on older Windows builds', () => {
    expect(systemAudioSource('win32', '10.0.19045')).toBe('loopback')
  })

  it('keeps device loopback when the build cannot be read', () => {
    expect(systemAudioSource('win32', '10.0')).toBe('loopback')
    expect(systemAudioSource('win32', '')).toBe('loopback')
  })

  it('uses loopback on macOS and Linux', () => {
    expect(systemAudioSource('darwin', '24.1.0')).toBe('loopback')
    expect(systemAudioSource('linux', '6.8.0-45-generic')).toBe('loopback')
  })
})

import { describe, expect, it } from 'vitest'
import {
  RECONNECT_DELAYS_MS,
  microphoneErrorMessage,
  nextStall,
  nextSystemAudio,
  retryOpen,
  shouldReopenSystem,
  type StallState
} from './recovery'

const noSleep = (): Promise<void> => Promise.resolve()

describe('retryOpen', () => {
  it('keeps trying until open succeeds, and says on which attempt', async () => {
    let calls = 0
    const result = await retryOpen(
      () => {
        calls++
        return Promise.resolve(calls === 3 ? 'stream' : null)
      },
      { delays: [1, 1, 1, 1], cancelled: () => false, dispose: () => undefined, sleep: noSleep }
    )
    expect(result).toEqual({ value: 'stream', attempt: 3 })
  })

  it('treats a thrown open as a failed attempt', async () => {
    let calls = 0
    const result = await retryOpen(
      () => {
        calls++
        return calls === 1 ? Promise.reject(new Error('busy')) : Promise.resolve('ok')
      },
      { delays: [1, 1], cancelled: () => false, dispose: () => undefined, sleep: noSleep }
    )
    expect(result).toEqual({ value: 'ok', attempt: 2 })
  })

  it('gives up after the last delay', async () => {
    const result = await retryOpen(() => Promise.resolve(null), {
      delays: [1, 1, 1],
      cancelled: () => false,
      dispose: () => undefined,
      sleep: noSleep
    })
    expect(result).toBeNull()
  })

  it('disposes what it opened when stopped meanwhile', async () => {
    let stopped = false
    const disposed: string[] = []
    const result = await retryOpen(
      () => {
        stopped = true
        return Promise.resolve('late')
      },
      {
        delays: [1],
        cancelled: () => stopped,
        dispose: (value) => disposed.push(value),
        sleep: noSleep
      }
    )
    expect(result).toBeNull()
    expect(disposed).toEqual(['late'])
  })

  it('does not open after a stop', async () => {
    let opened = 0
    const result = await retryOpen(
      () => {
        opened++
        return Promise.resolve('x')
      },
      { delays: [1], cancelled: () => true, dispose: () => undefined, sleep: noSleep }
    )
    expect(result).toBeNull()
    expect(opened).toBe(0)
  })

  it('backs off before settling into a steady interval', () => {
    expect(RECONNECT_DELAYS_MS.slice(0, 4)).toEqual([500, 1000, 2000, 4000])
    const total = RECONNECT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeGreaterThan(30_000)
    expect(total).toBeLessThan(120_000)
  })
})

describe('shouldReopenSystem', () => {
  it('reopens when the track ended', () => {
    expect(shouldReopenSystem({ trackEnded: true, before: 'a', after: 'a' })).toBe(true)
  })
  it('ignores a device change that left the default output alone', () => {
    expect(shouldReopenSystem({ trackEnded: false, before: 'a', after: 'a' })).toBe(false)
  })
  it('reopens when the default output moved', () => {
    expect(shouldReopenSystem({ trackEnded: false, before: 'a', after: 'b' })).toBe(true)
  })
  it('reopens when the default output is unknown', () => {
    expect(shouldReopenSystem({ trackEnded: false, before: null, after: 'b' })).toBe(true)
  })
})

describe('nextStall', () => {
  const run = (beats: boolean[]) => {
    let state: StallState = { stalls: 0, warned: false }
    return beats.map((stalled) => {
      const next = nextStall(state, stalled)
      state = next.state
      return { recover: next.recover, notice: next.notice }
    })
  }

  it('recovers on every stall but warns once, after two in a row', () => {
    expect(run([true, true, true])).toEqual([
      { recover: true, notice: null },
      { recover: true, notice: 'show' },
      { recover: true, notice: null }
    ])
  })

  it('clears the notice when frames return, and stays quiet for a single blip', () => {
    expect(run([true, true, false, true, false])).toEqual([
      { recover: true, notice: null },
      { recover: true, notice: 'show' },
      { recover: false, notice: 'clear' },
      { recover: true, notice: null },
      { recover: false, notice: null }
    ])
  })
})

describe('microphoneErrorMessage', () => {
  it('points to the right settings on each platform', () => {
    expect(microphoneErrorMessage('NotAllowedError', 'darwin')).toContain('System Settings')
    expect(microphoneErrorMessage('NotAllowedError', 'win32')).toContain('Privacy & security')
    expect(microphoneErrorMessage('NotAllowedError', 'win32')).not.toContain('System Settings')
    expect(microphoneErrorMessage('NotFoundError', 'linux')).toContain('No microphone found')
  })
  it('leaves unknown errors to their own message', () => {
    expect(microphoneErrorMessage('TypeError', 'darwin')).toBeNull()
  })
})

describe('nextSystemAudio', () => {
  it('goes live when computer audio opens, from any try', () => {
    expect(nextSystemAudio('retrying', 'restored')).toBe('live')
    expect(nextSystemAudio('unavailable', 'restored')).toBe('live')
    expect(nextSystemAudio('blocked', 'restored')).toBe('live')
  })

  it('gives up after the retries, and tries again on request', () => {
    expect(nextSystemAudio('retrying', 'unavailable')).toBe('unavailable')
    expect(nextSystemAudio('unavailable', 'retrying')).toBe('retrying')
    expect(nextSystemAudio('live', 'retrying')).toBe('retrying')
  })

  it('keeps an OS refusal over the retries, which cannot fix it', () => {
    expect(nextSystemAudio('retrying', 'blocked')).toBe('blocked')
    expect(nextSystemAudio('blocked', 'retrying')).toBe('blocked')
    expect(nextSystemAudio('blocked', 'unavailable')).toBe('blocked')
  })

  it('ignores a late refusal once computer audio is recording', () => {
    expect(nextSystemAudio('live', 'blocked')).toBe('live')
  })

  it('stays off when computer audio was not asked for', () => {
    expect(nextSystemAudio('off', 'restored')).toBe('off')
    expect(nextSystemAudio('off', 'unavailable')).toBe('off')
  })
})

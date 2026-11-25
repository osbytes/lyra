import { describe, expect, it } from 'vitest'
import { STILL_FINISHING_NOTICE, sessionCommandAction } from './sessionCommands'

describe('sessionCommandAction', () => {
  it('starts from idle', () => {
    expect(sessionCommandAction({ type: 'start', meeting: true }, 'idle')).toEqual({
      do: 'start',
      meeting: true,
      queued: false
    })
    expect(sessionCommandAction({ type: 'toggle' }, 'idle')).toEqual({
      do: 'start',
      meeting: false,
      queued: false
    })
  })

  it('never lets a start command end a recording', () => {
    for (const phase of ['starting', 'listening'] as const) {
      expect(sessionCommandAction({ type: 'start', meeting: false }, phase)).toEqual({
        do: 'ignore',
        notice: null
      })
    }
  })

  it('queues a start behind a recording that is finishing', () => {
    expect(sessionCommandAction({ type: 'start', meeting: false }, 'finishing')).toEqual({
      do: 'start',
      meeting: false,
      queued: true
    })
  })

  it('ignores a toggle while finishing, with a notice', () => {
    expect(sessionCommandAction({ type: 'toggle' }, 'finishing')).toEqual({
      do: 'ignore',
      notice: STILL_FINISHING_NOTICE
    })
  })

  it('stops (or cancels a warm-up) on toggle and stop', () => {
    expect(sessionCommandAction({ type: 'toggle' }, 'starting')).toEqual({ do: 'stop' })
    expect(sessionCommandAction({ type: 'toggle' }, 'listening')).toEqual({ do: 'stop' })
    expect(sessionCommandAction({ type: 'stop' }, 'idle')).toEqual({ do: 'stop' })
  })
})

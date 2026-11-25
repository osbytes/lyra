import { describe, expect, it } from 'vitest'
import { latest } from './latest'

describe('latest', () => {
  it('lets only the newest operation through', () => {
    const ops = latest()
    const first = ops.begin()
    const second = ops.begin()
    expect(ops.isCurrent(first)).toBe(false)
    expect(ops.isCurrent(second)).toBe(true)
  })

  it('cancel supersedes the running operation', () => {
    const ops = latest()
    const token = ops.begin()
    ops.cancel()
    expect(ops.isCurrent(token)).toBe(false)
  })

  it('resolves overlapping async work in favour of the last to begin', async () => {
    const ops = latest()
    const shown: string[] = []
    const disposed: string[] = []
    const open = async (id: string, delay: number): Promise<void> => {
      const token = ops.begin()
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!ops.isCurrent(token)) {
        disposed.push(id)
        return
      }
      shown.push(id)
    }
    // A slow first open finishes after a fast second one: the first must not win.
    await Promise.all([open('a', 20), open('b', 1)])
    expect(shown).toEqual(['b'])
    expect(disposed).toEqual(['a'])
  })
})

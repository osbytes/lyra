import { describe, expect, it } from 'vitest'
import { ActivityModelError, withStandardFallback } from './activityFallback'
import type { SpeakerModels } from './protocol'

const standard: SpeakerModels = { segmentation: 'seg.onnx', embedding: 'embed.onnx', activity: null }
const larger: SpeakerModels = { ...standard, activity: 'activity.onnx' }

/** Records each call's activity model, failing the calls `fail` says to. */
function runner(fail: (models: SpeakerModels) => Error | null) {
  const calls: (string | null)[] = []
  const run = (models: SpeakerModels): Promise<string> => {
    calls.push(models.activity)
    const error = fail(models)
    return error ? Promise.reject(error) : Promise.resolve(`labeled with ${models.activity ?? 'standard'}`)
  }
  return { calls, run }
}

describe('withStandardFallback', () => {
  it('runs once with the larger model when it works', async () => {
    const { calls, run } = runner(() => null)
    const reasons: string[] = []
    await expect(withStandardFallback(larger, run, (reason) => reasons.push(reason))).resolves.toBe(
      'labeled with activity.onnx'
    )
    expect(calls).toEqual(['activity.onnx'])
    expect(reasons).toEqual([])
  })

  it('labels with the standard model, and says why, when the larger one fails', async () => {
    const { calls, run } = runner((models) =>
      models.activity ? new ActivityModelError('The operating system cannot run %1.') : null
    )
    const reasons: string[] = []
    await expect(withStandardFallback(larger, run, (reason) => reasons.push(reason))).resolves.toBe(
      'labeled with standard'
    )
    expect(calls).toEqual(['activity.onnx', null])
    expect(reasons).toEqual(['The operating system cannot run %1.'])
  })

  it('passes on any other failure without retrying', async () => {
    const { calls, run } = runner(() => new Error('No such file'))
    const reasons: string[] = []
    await expect(withStandardFallback(larger, run, (reason) => reasons.push(reason))).rejects.toThrow('No such file')
    expect(calls).toEqual(['activity.onnx'])
    expect(reasons).toEqual([])
  })

  it('has nothing to fall back from with the standard model', async () => {
    const { calls, run } = runner(() => new ActivityModelError('unexpected'))
    await expect(withStandardFallback(standard, run, () => undefined)).rejects.toThrow('unexpected')
    expect(calls).toEqual([null])
  })

  it('fails if the standard model fails too', async () => {
    const { calls, run } = runner((models) =>
      models.activity ? new ActivityModelError('no runtime') : new Error('Speaker worker stopped')
    )
    await expect(withStandardFallback(larger, run, () => undefined)).rejects.toThrow('Speaker worker stopped')
    expect(calls).toEqual(['activity.onnx', null])
  })
})

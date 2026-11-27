/**
 * The larger speaker model is optional: when it can't run (its runtime won't load on this
 * computer, its worker crashed), speakers are labeled with the standard model instead of the
 * session failing, and the person is told once (`meetingActivity.ts`).
 */
import type { SpeakerModels } from './protocol'

/** A failure of the larger speaker model itself, not of the recording or the other models. */
export class ActivityModelError extends Error {
  override name = 'ActivityModelError'
}

/**
 * Runs `run` with `models`; if the larger model fails, says why through `onFallback` and runs
 * it again without that model. Any other error is the caller's.
 */
export async function withStandardFallback<T>(
  models: SpeakerModels,
  run: (models: SpeakerModels) => Promise<T>,
  onFallback: (reason: string) => void
): Promise<T> {
  if (!models.activity) return run(models)
  try {
    return await run(models)
  } catch (error) {
    if (!(error instanceof ActivityModelError)) throw error
    onFallback(error.message)
    return run({ ...models, activity: null })
  }
}

/**
 * Runs the speaker-activity network (`speakerActivity.ts`) with ONNX Runtime. Only the activity
 * worker (`activityWorker.ts`) loads this: the runtime is a native module, a recording takes
 * seconds to minutes, and sherpa-onnx's own runtime can't share its process. The runtime is
 * loaded on first use, not with the worker: it has no build for Intel Macs, where the setting is
 * unavailable (`speakers.ts`).
 */
import type * as Runtime from 'onnxruntime-node'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { MEL_BANDS } from './melFeatures'
import { ACTIVITY_HIDDEN, type ActivityStepResult, type RunStep } from './speakerActivity'

/** The model reads eight feature rows as one frame. */
const STACK = 8

type Loaded = { runtime: typeof Runtime; session: InferenceSession }

let loaded: { path: string; model: Promise<Loaded> } | null = null

function load(path: string, threads: number): Promise<Loaded> {
  if (loaded?.path !== path) {
    const model = import('onnxruntime-node').then(async (runtime) => ({
      runtime,
      session: await runtime.InferenceSession.create(path, { intraOpNumThreads: threads })
    }))
    const entry = { path, model }
    // A failed load isn't kept: the next step tries again.
    model.catch(() => {
      if (loaded === entry) loaded = null
    })
    loaded = entry
  }
  return loaded.model
}

/** Loads the runtime and the model without running it: whether it can run here at all. */
export async function checkActivityModel(path: string, threads: number): Promise<void> {
  await load(path, threads)
}

function floats(tensor: Tensor | undefined, name: string): Float32Array {
  if (!(tensor?.data instanceof Float32Array)) throw new Error(`The speaker model returned no ${name}`)
  // A copy: the runtime owns the tensor's memory and frees it with the tensor.
  return Float32Array.from(tensor.data)
}

/** One step of the model: a chunk of features read together with the cached frames. */
export function activityStep(modelPath: string, threads: number): RunStep {
  return async ({ features, featureFrames, cached }): Promise<ActivityStepResult> => {
    const { runtime, session } = await load(modelPath, threads)
    const cachedFlat = new Float32Array(cached.length * ACTIVITY_HIDDEN)
    cached.forEach((frame, index) => {
      cachedFlat.set(frame, index * ACTIVITY_HIDDEN)
    })
    const frames = cached.length + Math.ceil(featureFrames / STACK)
    const result = await session.run({
      input_features: new runtime.Tensor('float32', features, [1, featureFrames, MEL_BANDS]),
      cached_embeds: new runtime.Tensor('float32', cachedFlat, [1, cached.length, ACTIVITY_HIDDEN]),
      attention_mask: new runtime.Tensor('int64', new BigInt64Array(frames).fill(1n), [1, frames])
    })
    return {
      logits: floats(result.logits, 'logits'),
      frames: floats(result.chunk_embeds, 'frames'),
      silence: floats(result.silence_embeds, 'silence frame')
    }
  }
}

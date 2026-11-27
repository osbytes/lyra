/**
 * Messages to and from the activity worker (`activityWorker.ts`). The speaker worker
 * (`worker.ts`) sends it steps over a port main hands to both; main itself only asks it to check
 * that the model loads. The activity model runs on `onnxruntime-node`, which can't share a
 * process with `sherpa-onnx-node`: each ships its own `onnxruntime.dll`, and Windows gives the
 * second addon the one already loaded, whose exports don't match ("The operating system cannot
 * run %1").
 */
import { z } from 'zod'

// `z.instanceof` would narrow the buffer to `ArrayBuffer`; the model's arrays may sit on any.
const Floats = z.custom<Float32Array>((value) => value instanceof Float32Array)

export const ActivityWorkerRequest = z.object({
  id: z.number(),
  modelPath: z.string(),
  threads: z.number(),
  features: Floats,
  featureFrames: z.number(),
  cached: z.array(Floats)
})
export type ActivityWorkerRequest = z.infer<typeof ActivityWorkerRequest>

export const ActivityWorkerResponse = z.discriminatedUnion('ok', [
  z.object({
    id: z.number(),
    ok: z.literal(true),
    result: z.object({ logits: Floats, frames: Floats, silence: Floats })
  }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() })
])
export type ActivityWorkerResponse = z.infer<typeof ActivityWorkerResponse>

/** From main, on the worker's own channel: load the model and say whether it worked. */
export const ActivityCheckRequest = z.object({ type: z.literal('check'), modelPath: z.string() })
export type ActivityCheckRequest = z.infer<typeof ActivityCheckRequest>

export const ActivityCheckResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() })
])
export type ActivityCheckResult = z.infer<typeof ActivityCheckResult>

/**
 * Activity worker: runs the larger speaker model (`activityModel.ts`, on `onnxruntime-node`) in
 * a utilityProcess of its own, so its ONNX Runtime never meets sherpa-onnx's in one process
 * (`activityProtocol.ts`). Main sends it one port; the speaker worker holds the other end.
 */
import type { MessagePortMain } from 'electron'
import { activityStep, checkActivityModel } from './activityModel'
import {
  ActivityCheckRequest,
  ActivityWorkerRequest,
  type ActivityCheckResult,
  type ActivityWorkerResponse
} from './activityProtocol'

async function handle(data: unknown): Promise<ActivityWorkerResponse> {
  const parsed = ActivityWorkerRequest.safeParse(data)
  if (!parsed.success) return { id: -1, ok: false, error: 'Malformed activity request' }
  const { id, modelPath, threads, features, featureFrames, cached } = parsed.data
  try {
    const result = await activityStep(modelPath, threads)({ features, featureFrames, cached })
    return { id, ok: true, result }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function serve(port: MessagePortMain): void {
  port.on('message', (event) => {
    void handle(event.data).then((response) => {
      port.postMessage(response)
    })
  })
  // The speaker worker is gone; main starts a fresh pair with the next request.
  port.on('close', () => {
    process.exit(0)
  })
  port.start()
}

async function check(modelPath: string): Promise<ActivityCheckResult> {
  try {
    await checkActivityModel(modelPath, 1)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

process.parentPort.on('message', (event: Electron.MessageEvent) => {
  const [port] = event.ports
  if (port) {
    serve(port)
    return
  }
  const request = ActivityCheckRequest.safeParse(event.data)
  if (!request.success) return
  void check(request.data.modelPath).then((result) => {
    process.parentPort.postMessage(result)
  })
})

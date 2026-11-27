/**
 * The speaker worker's side of the activity worker (`activityWorker.ts`): steps of the larger
 * speaker model sent over the port main handed it, each answered by id. Every way the model can
 * fail here is an `ActivityModelError`, so main can label with the standard model instead.
 */
import { ActivityWorkerResponse, type ActivityWorkerRequest } from './activityProtocol'
import { ActivityModelError } from './activityFallback'
import type { RunStep } from './speakerActivity'

/** The parts of a `MessagePortMain` used here, so tests can pass their own. */
export type ActivityPort = {
  postMessage: (message: ActivityWorkerRequest) => void
  on: ((event: 'message', listener: (event: { data: unknown }) => void) => unknown) &
    ((event: 'close', listener: () => void) => unknown)
  start: () => void
}

type Pending = {
  resolve: (result: Awaited<ReturnType<RunStep>>) => void
  reject: (error: Error) => void
}

export type ActivityClient = {
  /** Uses this port from now on; steps still waiting on the old one fail. */
  connect: (port: ActivityPort) => void
  step: (modelPath: string, threads: number) => RunStep
}

export function activityClient(): ActivityClient {
  let current: ActivityPort | null = null
  let nextId = 1
  const pending = new Map<number, Pending & { port: ActivityPort }>()

  const failAll = (port: ActivityPort, message: string): void => {
    for (const [id, entry] of pending) {
      if (entry.port !== port) continue
      pending.delete(id)
      entry.reject(new ActivityModelError(message))
    }
  }

  return {
    connect(port) {
      if (current) failAll(current, 'The speaker model worker was replaced')
      current = port
      port.on('message', (event) => {
        const parsed = ActivityWorkerResponse.safeParse(event.data)
        if (!parsed.success) return
        const entry = pending.get(parsed.data.id)
        if (!entry) return
        pending.delete(parsed.data.id)
        if (parsed.data.ok) entry.resolve(parsed.data.result)
        else entry.reject(new ActivityModelError(parsed.data.error))
      })
      port.on('close', () => {
        if (current === port) current = null
        failAll(port, 'The speaker model worker stopped')
      })
      port.start()
    },
    step: (modelPath, threads) => ({ features, featureFrames, cached }) =>
      new Promise((resolve, reject) => {
        const port = current
        if (!port) {
          reject(new ActivityModelError('The speaker model worker is not running'))
          return
        }
        const id = nextId++
        pending.set(id, { resolve, reject, port })
        port.postMessage({ id, modelPath, threads, features, featureFrames, cached: [...cached] })
      })
  }
}

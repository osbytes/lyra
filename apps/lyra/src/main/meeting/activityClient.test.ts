import { describe, expect, it } from 'vitest'
import { activityClient, type ActivityPort } from './activityClient'
import { ActivityModelError } from './activityFallback'
import type { ActivityWorkerRequest } from './activityProtocol'

/** A port whose other end the test plays: it sees each request and answers when told to. */
function fakePort() {
  const sent: ActivityWorkerRequest[] = []
  const listeners: { message: ((event: { data: unknown }) => void)[]; close: (() => void)[] } = {
    message: [],
    close: []
  }
  const port: ActivityPort = {
    postMessage: (message) => {
      sent.push(message)
    },
    on: (event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)) => {
      if (event === 'message') listeners.message.push(listener)
      else listeners.close.push(() => {
        listener({ data: null })
      })
    },
    start: () => undefined
  }
  return {
    port,
    sent,
    reply: (data: unknown) => {
      for (const listener of listeners.message) listener({ data })
    },
    close: () => {
      for (const listener of listeners.close) listener()
    }
  }
}

const step = { features: Float32Array.of(1, 2), featureFrames: 1, cached: [Float32Array.of(3)] }
const result = { logits: Float32Array.of(0.5), frames: Float32Array.of(0.1), silence: Float32Array.of(0) }

describe('activityClient', () => {
  it('sends a step over the port and resolves with the answer to its id', async () => {
    const client = activityClient()
    const remote = fakePort()
    client.connect(remote.port)
    const pending = client.step('model.onnx', 4)(step)
    expect(remote.sent).toHaveLength(1)
    const [request] = remote.sent
    expect(request).toMatchObject({ modelPath: 'model.onnx', threads: 4, featureFrames: 1 })
    // An answer to another id, or one that isn't a response, is ignored.
    remote.reply({ id: (request?.id ?? 0) + 1, ok: true, result })
    remote.reply('noise')
    remote.reply({ id: request?.id, ok: true, result })
    await expect(pending).resolves.toEqual(result)
  })

  it('fails a step the worker couldn’t run as the larger model’s failure', async () => {
    const client = activityClient()
    const remote = fakePort()
    client.connect(remote.port)
    const pending = client.step('model.onnx', 4)(step)
    remote.reply({ id: remote.sent[0]?.id, ok: false, error: 'The operating system cannot run %1.' })
    await expect(pending).rejects.toBeInstanceOf(ActivityModelError)
    await expect(pending).rejects.toThrow('The operating system cannot run %1.')
  })

  it('fails waiting steps when the worker goes, and new ones until a port comes', async () => {
    const client = activityClient()
    const remote = fakePort()
    client.connect(remote.port)
    const pending = client.step('model.onnx', 4)(step)
    remote.close()
    await expect(pending).rejects.toBeInstanceOf(ActivityModelError)
    await expect(client.step('model.onnx', 4)(step)).rejects.toBeInstanceOf(ActivityModelError)
  })

  it('fails steps waiting on an old port when a new one replaces it', async () => {
    const client = activityClient()
    const first = fakePort()
    client.connect(first.port)
    const old = client.step('model.onnx', 4)(step)
    const second = fakePort()
    client.connect(second.port)
    await expect(old).rejects.toBeInstanceOf(ActivityModelError)
    const next = client.step('model.onnx', 4)(step)
    expect(first.sent).toHaveLength(1)
    second.reply({ id: second.sent[0]?.id, ok: true, result })
    await expect(next).resolves.toEqual(result)
  })
})

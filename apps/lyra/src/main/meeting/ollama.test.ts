import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MeetingNotes, type NotesLine } from './notesFormat'
import {
  contextLengthOf,
  createOllamaNotesWriter,
  detectLocalServers,
  forgetProbes,
  isOllama,
  listLocalModels,
  ollamaChatBody,
  serverRoot,
  type Fetch
} from './ollama'

type Call = { url: string; method: string; body: unknown }

const RequestBody = z.record(z.string(), z.unknown())

/**
 * A fake fetch: `routes` maps a URL to a JSON answer, an HTTP status to fail with, or a function
 * of the request body that gives the answer.
 */
function fakeFetch(routes: Record<string, number | object | ((body: unknown) => unknown)>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchFn: Fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw = init?.body
    const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
    calls.push({ url, method: init?.method ?? 'GET', body })
    if (!(url in routes)) return Promise.reject(new TypeError('fetch failed'))
    const route = routes[url]
    const answer: unknown = typeof route === 'function' ? route(body) : route
    if (typeof answer === 'number') return Promise.resolve(Response.json({ error: 'nope' }, { status: answer }))
    return Promise.resolve(Response.json(answer))
  }
  return { fetch: fetchFn, calls }
}

/** `Name: text` lines as the notes pipeline gets them, `seconds` apart. */
function linesOf(transcript: string, seconds = 5): NotesLine[] {
  return transcript.split('\n').map((line, index) => {
    const at = line.indexOf(': ')
    return { speaker: line.slice(0, at), text: line.slice(at + 2), start: index * seconds, end: index * seconds + seconds }
  })
}

const notes: MeetingNotes = {
  decisions: ['Ship Friday'],
  actionItems: [{ owner: 'Sam', task: 'Fix the installer' }],
  openQuestions: [],
  summary: 'Planned the release.'
}

/** Answers a chat request in the shape its `format` asks for: notes, action items or a summary. */
function answerFor(body: unknown): unknown {
  const shape = z.object({ format: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(body)
  const keys = Object.keys(shape.format.properties)
  const { actionItems, ...draft } = notes
  if (keys.includes('actionItems')) {
    return { actionItems: actionItems.map((item) => ({ quote: 'I will fix the installer', ...item })) }
  }
  if (keys.includes('title')) return { ...draft, title: 'Budget' }
  return keys.length === 1 ? { summary: 'All of it.' } : draft
}

beforeEach(() => {
  forgetProbes()
})

describe('serverRoot', () => {
  it('drops the /v1 of an OpenAI-compatible address and keeps a proxy path', () => {
    expect(serverRoot('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(serverRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(serverRoot('https://box.lan/ollama/v1')).toBe('https://box.lan/ollama')
  })
})

describe('isOllama', () => {
  it('asks the configured host once and remembers a yes', async () => {
    const { fetch, calls } = fakeFetch({ 'http://localhost:11434/api/version': { version: '0.12.0' } })
    expect(await isOllama('http://localhost:11434/v1', fetch)).toBe(true)
    expect(await isOllama('http://localhost:11434/v1', fetch)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('says no for a server that answers something else (LM Studio)', async () => {
    const { fetch } = fakeFetch({ 'http://localhost:1234/api/version': { error: 'Unexpected endpoint' } })
    expect(await isOllama('http://localhost:1234/v1', fetch)).toBe(false)
  })
})

describe('ollamaChatBody', () => {
  it('asks for a schema-shaped, non-streaming answer with the context size, and unloads after', () => {
    const body = RequestBody.parse(
      ollamaChatBody({ model: 'llama3.1', system: 's', prompt: 'p', schema: MeetingNotes, numCtx: 16384, numPredict: 2048, unload: true })
    )
    expect(body.stream).toBe(false)
    expect(body.keep_alive).toBe(0)
    expect(body.options).toEqual({ num_ctx: 16384, num_predict: 2048, temperature: 0.2 })
    expect(z.object({ type: z.literal('object') }).safeParse(body.format).success).toBe(true)
  })
})

describe('contextLengthOf', () => {
  it('reads the architecture-prefixed context length', () => {
    expect(contextLengthOf({ 'general.architecture': 'llama', 'llama.context_length': 131072 })).toBe(131072)
    expect(contextLengthOf(undefined)).toBeNull()
  })
})

describe('createOllamaNotesWriter', () => {
  const root = 'http://localhost:11434'

  it('writes notes and then action items, capping num_ctx and unloading the model after', async () => {
    const { fetch, calls } = fakeFetch({
      [`${root}/api/show`]: { model_info: { 'llama.context_length': 131072 } },
      [`${root}/api/chat`]: (body: unknown) => ({ message: { content: JSON.stringify(answerFor(body)) }, done_reason: 'stop' })
    })
    const writer = createOllamaNotesWriter({ baseUrl: `${root}/v1`, model: 'llama3.1', apiKey: null, onDevice: true, fetch })
    expect(await writer.notes(linesOf('Sam: I will fix the installer.'))).toEqual({ ...notes, sections: [] })
    const chat = calls.filter((call) => call.url.endsWith('/api/chat'))
    expect(chat).toHaveLength(2)
    expect(RequestBody.parse(chat[0]?.body).keep_alive).not.toBe(0)
    const body = RequestBody.parse(chat[1]?.body)
    expect(body.keep_alive).toBe(0)
    expect(z.object({ num_ctx: z.number() }).parse(body.options).num_ctx).toBe(16384)
  })

  it('splits a meeting too long for the context and keeps the model loaded until the last call', async () => {
    const { fetch, calls } = fakeFetch({
      [`${root}/api/show`]: { model_info: { 'qwen2.context_length': 4096 } },
      [`${root}/api/chat`]: (body: unknown) => ({ message: { content: JSON.stringify(answerFor(body)) } })
    })
    const writer = createOllamaNotesWriter({ baseUrl: `${root}/v1`, model: 'qwen2.5', apiKey: null, onDevice: true, fetch })
    const transcript = Array.from({ length: 600 }, (_, i) => `Speaker: 第${String(i)}句 我们讨论预算和时间表`).join('\n')
    const written = await writer.notes(linesOf(transcript))
    expect(written.sections.length).toBeGreaterThan(1)
    expect(written.summary).toBe('All of it.')
    // The same decision from every section is kept once.
    expect(written.decisions).toEqual(['Ship Friday'])
    const chat = calls.filter((call) => call.url.endsWith('/api/chat')).map((call) => RequestBody.parse(call.body))
    expect(chat.length).toBeGreaterThan(2)
    expect(chat.filter((body) => body.keep_alive === 0)).toHaveLength(1)
    expect(chat.at(-1)?.keep_alive).toBe(0)
  })

  it('rejects a reply that is not in the notes shape, and names a missing model', async () => {
    const bad = fakeFetch({ [`${root}/api/chat`]: { message: { content: '{"summary": 3}' } } })
    const writer = createOllamaNotesWriter({ baseUrl: root, model: 'm', apiKey: null, onDevice: true, fetch: bad.fetch })
    await expect(writer.notes(linesOf('Sam: x'))).rejects.toThrow('expected shape')
    const missing = fakeFetch({ [`${root}/api/chat`]: 404 })
    const writer2 = createOllamaNotesWriter({ baseUrl: root, model: 'gone', apiKey: null, onDevice: true, fetch: missing.fetch })
    await expect(writer2.notes(linesOf('Sam: x'))).rejects.toThrow('ollama pull gone')
  })

  it('says when the server is not running', async () => {
    const { fetch } = fakeFetch({})
    const writer = createOllamaNotesWriter({ baseUrl: root, model: 'm', apiKey: null, onDevice: true, fetch })
    await expect(writer.title('hello there')).rejects.toThrow('Is it running?')
  })
})

describe('listLocalModels', () => {
  it('lists Ollama tags, or an OpenAI-compatible model list', async () => {
    const ollama = fakeFetch({
      'http://localhost:11434/api/version': { version: '0.12.0' },
      'http://localhost:11434/api/tags': { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] }
    })
    expect(await listLocalModels('http://localhost:11434/v1', { fetch: ollama.fetch })).toEqual(['llama3.1:8b', 'qwen2.5:7b'])
    const lmStudio = fakeFetch({ 'http://localhost:1234/v1/models': { data: [{ id: 'qwen2.5-7b-instruct' }] } })
    expect(await listLocalModels('http://localhost:1234/v1', { fetch: lmStudio.fetch })).toEqual(['qwen2.5-7b-instruct'])
  })
})

describe('detectLocalServers', () => {
  it('reports only the loopback servers that answered, and asks nothing else', async () => {
    const { fetch, calls } = fakeFetch({ 'http://127.0.0.1:1234/v1/models': { data: [] } })
    expect(await detectLocalServers(fetch)).toEqual([{ kind: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1' }])
    expect(calls.every((call) => call.url.startsWith('http://127.0.0.1:'))).toBe(true)
  })
})

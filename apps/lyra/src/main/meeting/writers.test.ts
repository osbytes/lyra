import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/settings'
import type { MeetingNotes } from './notesFormat'
import { createFakeNotesWriter, createModelNotesWriter, testNotesWriter } from './notesWriter'
import { forgetProbes, type Fetch } from './ollama'
import { chooseWriter } from './writers'

// Importing the provider SDKs builds their default instances, which refuse an empty
// ANTHROPIC_BASE_URL (some shells export one); the tests never use those instances.
vi.hoisted(() => {
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined)
  vi.stubEnv('OPENAI_BASE_URL', undefined)
})

const notes: MeetingNotes = { decisions: [], actionItems: [], openQuestions: [], summary: 'Done.' }

function mockModel(prompts: string[], text: string = JSON.stringify(notes)): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      prompts.push(JSON.stringify(options.prompt))
      return Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }
        },
        warnings: []
      })
    }
  })
}

const longTranscript = Array.from({ length: 2000 }, (_, i) => `Sam: point number ${String(i)} about the budget`).join('\n')

describe('createModelNotesWriter', () => {
  it('sends a hosted model the whole meeting in one call', async () => {
    const prompts: string[] = []
    await createModelNotesWriter(mockModel(prompts), 'hosted').notes(longTranscript)
    expect(prompts).toHaveLength(1)
  })

  it('splits for a small budget (an OpenAI-compatible server) and merges', async () => {
    const prompts: string[] = []
    await createModelNotesWriter(mockModel(prompts), 'compatible', { budget: 2500 }).notes(longTranscript)
    expect(prompts.length).toBeGreaterThan(3)
  })
})

describe('testNotesWriter', () => {
  it('reports success, or the writer’s readable error', async () => {
    const ok = await testNotesWriter(createModelNotesWriter(mockModel([], '{"title":"Garden plans"}'), 'mock'))
    expect(ok.ok).toBe(true)
    const bad = await testNotesWriter(createModelNotesWriter(mockModel([], 'nope'), 'mock'))
    expect(bad.ok ? '' : bad.error).toContain('expected shape')
  })
})

describe('chooseWriter', () => {
  const local = createFakeNotesWriter({ notes, title: null })
  const base: Settings = {
    notesDir: '/tmp/notes',
    fileFormat: 'txt',
    micDeviceId: null,
    hotkey: 'Alt+Space',
    launchAtLogin: false,
    micPrompt: { enabled: false, ignoredApps: [] },
    meetingPrompt: false,
    audioRetentionDays: null,
    captureSystemAudio: false,
    transcriptionLanguage: 'auto',
    notesEngine: 'cloud',
    cloudProvider: 'openai-compatible',
    cloudModel: 'llama3.1',
    cloudBaseUrl: 'http://localhost:11434/v1',
    detailsPanel: false,
    sidebar: true,
    sidebarWidth: 260,
    detailsWidth: 300,
    meetingNoticeSeen: true,
    semanticSearch: false
  }
  const choose = (patch: Partial<Settings>, fetchFn: Fetch) =>
    chooseWriter({
      settings: () => ({ ...base, ...patch }),
      apiKey: () => Promise.resolve(null),
      baseUrls: { anthropic: null, openai: null },
      local,
      fetch: fetchFn
    })

  it('uses the native Ollama writer when the server is Ollama, marked on-device on loopback', async () => {
    forgetProbes()
    const fetchFn: Fetch = (input) =>
      input === 'http://localhost:11434/api/version'
        ? Promise.resolve(Response.json({ version: '0.12.0' }))
        : Promise.reject(new TypeError('fetch failed'))
    const writer = await choose({}, fetchFn)
    expect(writer?.name).toBe('Ollama (llama3.1)')
    expect(writer?.onDevice).toBe(true)
  })

  it('uses the AI SDK writer for another server, off-device even on loopback', async () => {
    forgetProbes()
    const down: Fetch = () => Promise.reject(new TypeError('fetch failed'))
    const remote = await choose({ cloudBaseUrl: 'https://llm.example.com/v1' }, down)
    expect(remote?.name).toBe('OpenAI-compatible server (llama3.1)')
    expect(remote?.onDevice).toBe(false)
    const loopback = await choose({ cloudBaseUrl: 'http://127.0.0.1:1234/v1' }, down)
    expect(loopback?.onDevice).toBe(false)
  })
})

import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/settings'
import type { MeetingNotes, NotesLine } from './notesFormat'
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
const draft = { decisions: [], openQuestions: [], summary: 'Done.' }

/** `Name: text` lines as the notes pipeline gets them, `seconds` apart. */
function linesOf(transcript: string, seconds = 5): NotesLine[] {
  return transcript.split('\n').map((line, index) => {
    const at = line.indexOf(': ')
    return { speaker: line.slice(0, at), text: line.slice(at + 2), start: index * seconds, end: index * seconds + seconds }
  })
}

/** Answers each call in the shape it asks for (`text` when given): notes, a section's, or a summary. */
function mockModel(prompts: string[], text?: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const prompt = JSON.stringify(options.prompt)
      prompts.push(prompt)
      const answer = prompt.includes('<parts>')
        ? { summary: 'Done.' }
        : prompt.includes('You find the action items')
          ? { actionItems: [] }
          : prompt.includes('This is part ')
            ? { ...draft, title: 'Budget' }
            : draft
      return Promise.resolve({
        content: [{ type: 'text', text: text ?? JSON.stringify(answer) }],
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

const longTranscript = linesOf(
  Array.from({ length: 2000 }, (_, i) => `Sam: point number ${String(i)} about the budget`).join('\n'),
  0
)

describe('createModelNotesWriter', () => {
  it('sends a hosted model the whole meeting at once: its notes, then its action items', async () => {
    const prompts: string[] = []
    expect(await createModelNotesWriter(mockModel(prompts), 'hosted').notes(longTranscript)).toEqual({ ...notes, sections: [] })
    expect(prompts).toHaveLength(2)
  })

  it('cuts sections for a small budget (an OpenAI-compatible server) and sums them up', async () => {
    const prompts: string[] = []
    const written = await createModelNotesWriter(mockModel(prompts), 'compatible', { budget: 2500 }).notes(longTranscript)
    expect(prompts.length).toBeGreaterThan(3)
    // Notes and action items for each section, then the summary.
    expect(written.sections.length).toBe((prompts.length - 1) / 2)
    expect(written.sections.every((section) => section.title === 'Budget')).toBe(true)
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
    vocabulary: [],
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

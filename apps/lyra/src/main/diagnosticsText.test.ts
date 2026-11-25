import { describe, expect, it } from 'vitest'
import { formatBytes } from '../shared/bytes'
import type { Settings } from '../shared/settings'
import { diagnosticsText, notesEngineLabel, shortenHome } from './diagnosticsText'

const settings: Settings = {
  notesDir: '/Users/ana/.lyra',
  fileFormat: 'txt',
  micDeviceId: null,
  hotkey: 'Alt+Space',
  launchAtLogin: false,
  micPrompt: { enabled: false, ignoredApps: [] },
  meetingPrompt: false,
  audioRetentionDays: 30,
  captureSystemAudio: false,
  transcriptionLanguage: 'auto',
  vocabulary: ['Secret Project'],
  notesEngine: 'cloud',
  cloudProvider: 'openai-compatible',
  cloudModel: 'llama3.1',
  cloudBaseUrl: 'http://user:pw@localhost:11434/v1',
  detailsPanel: false,
  sidebar: true,
  sidebarWidth: 260,
  detailsWidth: 300,
  meetingNoticeSeen: true,
  semanticSearch: false
}

describe('shortenHome', () => {
  it('writes the home folder as ~ only at a folder boundary', () => {
    expect(shortenHome('/Users/ana/Library/Logs', '/Users/ana', false)).toBe('~/Library/Logs')
    expect(shortenHome('/Users/ana', '/Users/ana/', false)).toBe('~')
    expect(shortenHome('/Users/anabel/x', '/Users/ana', false)).toBe('/Users/anabel/x')
    expect(shortenHome('/opt/lyra', '/Users/ana', false)).toBe('/opt/lyra')
  })

  it('ignores case on Windows', () => {
    expect(shortenHome('c:\\users\\ana\\AppData', 'C:\\Users\\Ana', true)).toBe('~\\AppData')
  })
})

describe('formatBytes', () => {
  it('reads like a file manager', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(574_041_195)).toBe('547 MB')
    expect(formatBytes(2_104_932_768)).toBe('2.0 GB')
  })
})

describe('notesEngineLabel', () => {
  it('never shows a server address or its credentials', () => {
    const label = notesEngineLabel(settings)
    expect(label).toBe('OpenAI-compatible server on this computer (llama3.1)')
    expect(label).not.toContain('pw')
  })

  it('names hosted providers and their default model', () => {
    expect(notesEngineLabel({ ...settings, cloudProvider: 'anthropic', cloudModel: null })).toBe(
      'Anthropic (claude-opus-5-5)'
    )
    expect(notesEngineLabel({ ...settings, notesEngine: 'off' })).toBe('Off')
  })
})

describe('diagnosticsText', () => {
  it('lists versions, engines and folders, and nothing from settings beyond them', () => {
    const text = diagnosticsText({
      version: '0.4.0',
      os: 'darwin 15.1',
      arch: 'arm64',
      electron: '42.0.0',
      chrome: '140.0',
      node: '24.0.0',
      whisper: { model: 'whisper large-v3-turbo q5 (chunked)', backend: null },
      notesEngine: notesEngineLabel(settings),
      places: [{ id: 'models', label: 'Models', path: '~/Library/Lyra/models', bytes: 2048, complete: false }]
    })
    expect(text).toContain('Lyra 0.4.0')
    expect(text).toContain('not used yet')
    expect(text).toContain('Models: ~/Library/Lyra/models (2.0 KB+, not fully counted)')
    expect(text).not.toContain('Secret Project')
    expect(text).not.toContain('localhost')
  })
})

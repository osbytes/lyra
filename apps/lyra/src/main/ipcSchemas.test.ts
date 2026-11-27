import { describe, expect, it } from 'vitest'
import { isLoopbackUrl } from '../shared/settings'
import {
  CreatePageArg,
  MAX_SESSION_EDIT_CHARS,
  PageIdArg,
  SavePageArg,
  SessionOpsArg,
  SessionSeqArg,
  parseSettingsPatch
} from './ipcSchemas'

const app = { allowNotesDir: false }

describe('parseSettingsPatch', () => {
  it('passes good fields through', () => {
    expect(parseSettingsPatch({ fileFormat: 'md', sidebar: false }, app)).toEqual({
      patch: { fileFormat: 'md', sidebar: false },
      dropped: []
    })
  })

  it('drops a bad value and keeps the rest', () => {
    const { patch, dropped } = parseSettingsPatch({ cloudModel: 'not a model id!', fileFormat: 'txt' }, app)
    expect(patch).toEqual({ fileFormat: 'txt' })
    expect(dropped).toEqual(['cloudModel'])
  })

  it('throws on unknown fields and non-objects', () => {
    expect(() => parseSettingsPatch({ fileFormat: 'md', evil: true }, app)).toThrow()
    expect(() => parseSettingsPatch('fileFormat', app)).toThrow()
    expect(() => parseSettingsPatch(null, app)).toThrow()
    expect(() => parseSettingsPatch(['md'], app)).toThrow()
  })

  it('refuses notesDir from the app, and checks it in task runs', () => {
    expect(() => parseSettingsPatch({ notesDir: '/tmp/notes' }, app)).toThrow(/pickFolder/)
    expect(() => parseSettingsPatch({ notesDir: '\\\\attacker\\share' }, app)).toThrow(/pickFolder/)
    expect(parseSettingsPatch({ notesDir: '/tmp/notes' }, { allowNotesDir: true }).patch).toEqual({ notesDir: '/tmp/notes' })
  })

  it('takes http only for a server on this computer', () => {
    const url = (cloudBaseUrl: string): unknown => parseSettingsPatch({ cloudBaseUrl }, app).patch.cloudBaseUrl
    expect(url('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(url('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1')
    expect(url('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1')
    expect(url('https://gateway.example/v1')).toBe('https://gateway.example/v1')
    expect(url('http://gateway.example/v1')).toBeUndefined()
    expect(url('http://192.168.1.5:11434/v1')).toBeUndefined()
    expect(url('ftp://localhost/v1')).toBeUndefined()
    expect(parseSettingsPatch({ cloudBaseUrl: null }, app).patch).toEqual({ cloudBaseUrl: null })
  })
})

describe('isLoopbackUrl', () => {
  it('knows loopback hosts', () => {
    for (const url of ['http://localhost', 'http://LOCALHOST:1/x', 'http://127.0.0.1', 'http://127.255.0.9:80', 'http://127.1', 'http://[::1]/']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const url of ['http://localhost.evil.com', 'http://128.0.0.1', 'http://10.0.0.1', 'http://[::2]', 'http://127.0.0.1.nip.io', 'not a url', '']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })
})

describe('channel arguments', () => {
  it('caps page ids', () => {
    expect(PageIdArg.safeParse('a.txt').success).toBe(true)
    expect(PageIdArg.safeParse('').success).toBe(false)
    expect(PageIdArg.safeParse('a'.repeat(256)).success).toBe(false)
    expect(PageIdArg.safeParse(7).success).toBe(false)
  })

  it('checks savePage input', () => {
    expect(SavePageArg.safeParse({ id: 'a.txt', title: 'T', body: 'B' }).success).toBe(true)
    expect(SavePageArg.safeParse({ id: 'a.txt', title: 'T' }).success).toBe(false)
    expect(SavePageArg.safeParse({ id: 'a.txt', title: 1, body: 'B' }).success).toBe(false)
  })

  it('takes only known, bounded session edits', () => {
    expect(SessionOpsArg.safeParse([{ op: 'title', title: 'Hi' }]).success).toBe(true)
    expect(SessionOpsArg.safeParse([{ op: 'assign', ids: ['s1'], speaker: 'c2' }]).success).toBe(true)
    expect(SessionOpsArg.safeParse([]).success).toBe(false)
    expect(SessionOpsArg.safeParse([{ op: 'title' }]).success).toBe(false)
    expect(SessionOpsArg.safeParse([{ op: 'wipe' }]).success).toBe(false)
    expect(SessionOpsArg.safeParse(new Uint8Array([1, 2])).success).toBe(false)
    expect(SessionOpsArg.safeParse([{ op: 'notes', notes: 'x'.repeat(MAX_SESSION_EDIT_CHARS) }]).success).toBe(false)
    expect(SessionSeqArg.safeParse(3).success).toBe(true)
    expect(SessionSeqArg.safeParse(-1).success).toBe(false)
    expect(SessionSeqArg.safeParse(1.5).success).toBe(false)
  })

  it('defaults createPage options', () => {
    expect(CreatePageArg.parse(undefined)).toEqual({})
    expect(CreatePageArg.parse({ startedAt: '2026-01-02T03:04:05' })).toEqual({ startedAt: '2026-01-02T03:04:05' })
    expect(CreatePageArg.safeParse({ startedAt: 5 }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { hostedPrivacy, serverHost, serverPrivacy } from './summaryPrivacy'

describe('serverPrivacy', () => {
  it('says text stays here only for Ollama on this computer', () => {
    const note = serverPrivacy('http://127.0.0.1:11434/v1', 'ollama')
    expect(note.tone).toBe('info')
    expect(note.text).toContain('stay on this computer')
  })

  it('treats any other server on this computer as able to send text on', () => {
    for (const kind of ['other', 'unknown'] as const) {
      const note = serverPrivacy('http://localhost:1234/v1', kind)
      expect(note.tone).toBe('warning')
      expect(note.text).toContain('localhost:1234 on this computer')
      expect(note.text).toContain('can’t see where')
    }
  })

  it('warns that a server elsewhere gets the transcript, even if it is Ollama', () => {
    const note = serverPrivacy('https://gpu.example.com/v1', 'ollama')
    expect(note.tone).toBe('warning')
    expect(note.text).toContain('on another computer')
  })

  it('mentions titles after every recording, and what never leaves', () => {
    expect(hostedPrivacy('Anthropic', true)).toContain('suggest a title after each recording, including plain dictation')
    expect(hostedPrivacy('Anthropic', true)).toContain('typed notes stay on this computer')
  })
})

describe('serverHost', () => {
  it('drops credentials and paths', () => {
    expect(serverHost('https://me:secret@llm.example.com:8443/proxy/v1')).toBe('llm.example.com:8443')
  })
})

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { passesOnDisk, tracksOnDisk } from './sessionRecovery'

describe('rebuilding a manifest from the session folder', () => {
  it('finds the recorded tracks and their length', async () => {
    const audio = join(mkdtempSync(join(tmpdir(), 'lyra-rec-')), 'audio')
    mkdirSync(audio)
    writeFileSync(join(audio, 'mic.wav'), Buffer.alloc(44 + 32000 * 2))
    expect(await tracksOnDisk(audio)).toEqual([{ name: 'mic', file: 'mic.wav', sampleRate: 16000, seconds: 2 }])
    expect(await tracksOnDisk(join(audio, 'nowhere'))).toEqual([])
  })

  it('lists passes oldest first, reading what each says about itself', async () => {
    const raw = join(mkdtempSync(join(tmpdir(), 'lyra-rec-')), 'raw')
    mkdirSync(raw)
    writeFileSync(join(raw, 'live.json'), JSON.stringify({ kind: 'live', model: 'whisper', createdAt: '2026-01-01T00:00:00Z' }))
    writeFileSync(join(raw, 'pass-1.json'), JSON.stringify({ kind: 'diarized', model: 'pyannote', createdAt: '2026-01-02T00:00:00Z' }))
    writeFileSync(join(raw, 'broken.json'), '{')
    writeFileSync(join(raw, 'notes.txt'), 'x')
    expect(await passesOnDisk(raw)).toEqual([
      { id: 'live', kind: 'live', model: 'whisper', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'pass-1', kind: 'diarized', model: 'pyannote', createdAt: '2026-01-02T00:00:00Z' }
    ])
  })
})

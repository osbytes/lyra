import { describe, expect, it } from 'vitest'
import { manifestForDisk, parseManifest } from './sessionManifest'

const NOW = '2026-11-25T00:00:00.000Z'
const ID = '2026-11-25_10-00-00.txt'

const good = {
  version: 1,
  id: ID,
  startedAt: '2026-11-25T10:00:00.000Z',
  endedAt: null,
  updatedAt: '2026-11-25T10:30:00.000Z',
  tracks: [{ name: 'mic', file: 'mic.wav', sampleRate: 16000, seconds: 12 }],
  passes: [{ id: 'pass-1', kind: 'diarized', createdAt: NOW, model: 'm' }],
  audio: 'kept',
  title: 'Standup',
  titleAuto: false,
  preview: 'hi',
  tags: ['team'],
  speakers: 2,
  exportHash: 'abc',
  dirty: false
}

describe('parseManifest', () => {
  it('reads a current manifest as it is', () => {
    const read = parseManifest(good, ID, NOW)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.manifest).toEqual(good)
    expect(read.newer).toBe(false)
    expect(read.idMismatch).toBe(false)
  })

  it('drops tracks and passes whose names would escape the session folder', () => {
    const read = parseManifest(
      {
        ...good,
        tracks: [...good.tracks, { name: 'system', file: '../../x.wav', sampleRate: 16000, seconds: 1 }, { name: 'mic', file: '..', sampleRate: 1, seconds: 1 }],
        passes: [...good.passes, { id: '../evil', kind: 'live', createdAt: NOW, model: 'm' }, { id: 'p', kind: 'nope', createdAt: NOW, model: 'm' }]
      },
      ID,
      NOW
    )
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(read.manifest.tracks).toEqual(good.tracks)
    expect(read.manifest.passes).toEqual(good.passes)
  })

  it('falls back field by field', () => {
    const read = parseManifest({ version: 1, title: 42, audio: 'lost', tags: ['a', 3], speakers: 'x' }, ID, NOW)
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(read.manifest).toMatchObject({
      id: ID,
      startedAt: NOW,
      title: 'Untitled',
      titleAuto: true,
      audio: 'none',
      tags: ['a'],
      speakers: 0,
      exportHash: null,
      dirty: false
    })
    expect(read.idMismatch).toBe(true)
  })

  it('refuses what is not a manifest', () => {
    expect(parseManifest(null, ID, NOW).kind).toBe('invalid')
    expect(parseManifest([], ID, NOW).kind).toBe('invalid')
    expect(parseManifest({ ...good, version: 0 }, ID, NOW).kind).toBe('invalid')
    expect(parseManifest({ ...good, version: '2' }, ID, NOW).kind).toBe('invalid')
  })

  it('keeps a newer version and its unknown fields when written back', () => {
    const newer = { ...good, version: 3, futureField: { a: 1 } }
    const read = parseManifest(newer, ID, NOW)
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(read.newer).toBe(true)
    const written = manifestForDisk({ ...read.manifest, dirty: true }, read.raw)
    expect(written).toMatchObject({ version: 3, futureField: { a: 1 }, dirty: true, title: 'Standup' })
  })

  it('writes a plain manifest when there was no file', () => {
    const read = parseManifest(good, ID, NOW)
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(manifestForDisk(read.manifest, undefined)).toEqual(good)
  })
})

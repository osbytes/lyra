import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeOpenMarks,
  heardSpans,
  marksToResume,
  mergeLivePass,
  parseLiveFile,
  readLiveFile,
  writeLiveFile,
  type LiveSegment
} from './livePass'

function segment(id: string, start: number, track: 'mic' | 'system' = 'mic'): LiveSegment {
  return { id, start, end: start + 1, track, cluster: null, confidence: null, words: [{ text: ' hi', start, end: start + 1 }] }
}

const META = { model: 'm', createdAt: '2026-01-01T00:00:00.000Z' }

describe('mergeLivePass', () => {
  it('adds a take after earlier ones and keeps fields it does not know', () => {
    const existing = parseLiveFile(
      JSON.stringify({ id: 'live', kind: 'live', text: 'legacy', extra: 1, segments: [segment('a', 0)], clusters: [] })
    )
    const merged = mergeLivePass(existing, { ...META, take: 5, segments: [segment('b', 5)], untranscribed: [] })
    expect(merged.text).toBe('legacy')
    expect(merged.extra).toBe(1)
    expect(heardSpans(parseLiveFile(JSON.stringify(merged)))).toEqual([
      { track: 'mic', start: 0, end: 1 },
      { track: 'mic', start: 5, end: 6 }
    ])
  })

  it('saving a take twice replaces its words and its untranscribed marker', () => {
    const first = mergeLivePass(null, {
      ...META,
      take: 0,
      segments: [segment('a', 0)],
      untranscribed: [{ take: 0, track: 'mic', start: 1, end: 9 }]
    })
    expect(first.untranscribed).toEqual([{ take: 0, track: 'mic', start: 1, end: 9 }])
    const second = mergeLivePass(parseLiveFile(JSON.stringify(first)), {
      ...META,
      take: 0,
      segments: [segment('a', 0), segment('c', 3)],
      untranscribed: []
    })
    expect(second.segments).toHaveLength(2)
    expect('untranscribed' in second).toBe(false)
  })

  it("keeps another take's marker", () => {
    const earlier = parseLiveFile(
      JSON.stringify({ segments: [], untranscribed: [{ take: 0, track: 'system', start: 2, end: 4 }] })
    )
    const merged = mergeLivePass(earlier, { ...META, take: 10, segments: [], untranscribed: [] })
    expect(merged.untranscribed).toEqual([{ take: 0, track: 'system', start: 2, end: 4 }])
  })

  it('carries malformed segments through rather than dropping them', () => {
    const existing = parseLiveFile(JSON.stringify({ segments: [{ odd: true }, segment('a', 0)] }))
    const merged = mergeLivePass(existing, { ...META, take: 2, segments: [segment('b', 2)], untranscribed: [] })
    expect(merged.segments).toHaveLength(3)
  })
})

describe('live.json on disk', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lyra-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('moves an unreadable file aside instead of merging over it', async () => {
    await writeFile(join(dir, 'live.json'), '{"segments": [tru')
    const read = await readLiveFile(dir, new Date('2026-01-02T03:04:05.006Z'))
    expect(read.state).toBe('corrupt')
    expect(await readdir(dir)).toEqual(['live.corrupt-2026-01-02T03-04-05-006Z.json'])
    expect((await readLiveFile(dir)).state).toBe('missing')
  })

  it('writes through a temporary file and reads back', async () => {
    await writeLiveFile(dir, mergeLivePass(null, { ...META, take: 0, segments: [segment('a', 0)], untranscribed: [] }))
    expect(await readdir(dir)).toEqual(['live.json'])
    const read = await readLiveFile(dir)
    expect(read.state === 'ok' ? read.file.segments : null).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))).toMatchObject({ id: 'live', kind: 'live' })
  })
})

describe('untranscribed marks', () => {
  const file = {
    segments: [],
    untranscribed: [
      { take: 0, track: 'mic' as const, start: 40, end: 40, open: true },
      { take: 0, track: 'system' as const, start: 38.5, end: 38.5, open: true },
      { take: 100, track: 'mic' as const, start: 120, end: 130 }
    ]
  }

  it('closes the open marks of a take a crash cut short where the next take starts', () => {
    expect(closeOpenMarks(file, 60)?.untranscribed).toEqual([
      { take: 0, track: 'mic', start: 40, end: 60 },
      { take: 0, track: 'system', start: 38.5, end: 60 },
      { take: 100, track: 'mic', start: 120, end: 130 }
    ])
    expect(closeOpenMarks({ segments: [], untranscribed: [{ take: 0, track: 'mic', start: 1, end: 2 }] }, 60)).toBeNull()
  })

  it('runs open marks to the end of their audio, and drops what has none left', () => {
    const seconds = { mic: 125, system: 38.5 }
    expect(marksToResume(file.untranscribed, (track) => seconds[track])).toEqual([
      { take: 0, track: 'mic', start: 40, end: 125 },
      // The audio stops before the closed mark's end: only what's on disk is transcribed.
      { take: 100, track: 'mic', start: 120, end: 125 }
    ])
  })
})

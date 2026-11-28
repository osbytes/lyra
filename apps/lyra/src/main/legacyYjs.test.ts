import { describe, expect, it } from 'vitest'
import { legacySessionDoc, readFrames, readLegacyLog } from './legacyYjs'
import { CONCURRENT, legacyLog, PLAIN, TORN } from './legacyYjs.fixtures'

const log = legacyLog

describe('readLegacyLog', () => {
  it('reads text, maps, arrays and nested types', () => {
    const { doc, applied, damaged } = readLegacyLog(log(PLAIN))
    expect(applied).toBe(12)
    expect(damaged).toBe(false)
    expect(doc.text('title')).toBe('Design review')
    expect(doc.text('notes')).toBe('Hello world')
    expect(doc.text('summary')).toBe('')
    expect(doc.map('meta')).toEqual({
      tags: ['design'],
      speakers: { c1: { name: 'Sam', confirmed: true, matches: [{ personId: 'p1', score: 0.75 }] } },
      speakerSeq: 2
    })
    expect(doc.array('transcript')).toEqual([
      { id: 's0', start: 1.5, cluster: 'c1', text: 'Hi, there', original: 'Hi there' }
    ])
  })

  it('orders concurrent edits as Yjs does', () => {
    const { doc, damaged } = readLegacyLog(log(CONCURRENT))
    expect(damaged).toBe(false)
    // Same place, same neighbours: the lower client id goes first. A map key keeps the value
    // that ends up rightmost, the higher client's.
    expect(doc.text('title')).toBe('aXYc')
    expect(doc.map('meta')).toEqual({ name: 'from 2' })
  })

  it('keeps what came before a torn frame', () => {
    const { doc, applied, damaged } = readLegacyLog(log(TORN))
    expect(applied).toBe(1)
    expect(damaged).toBe(true)
    expect(doc.text('notes')).toBe('Kept')
  })

  it('reads nothing from an empty log', () => {
    const { doc, applied, damaged } = readLegacyLog(new Uint8Array(0))
    expect(applied).toBe(0)
    expect(damaged).toBe(false)
    expect(doc.text('title')).toBe('')
    expect(doc.array('transcript')).toEqual([])
  })

  it('stops before a torn last frame', () => {
    // A 3-byte frame, then a header promising 64 bytes and only three of them.
    const bytes = new Uint8Array([3, 0, 0, 0, 1, 2, 3, 64, 0, 0, 0, 9, 9, 9])
    const { frames, end } = readFrames(bytes)
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3]])
    expect(end).toBe(7)
  })
})

describe('legacySessionDoc', () => {
  it('reads Lyra 0.6 documents into the plain shape', () => {
    const doc = legacySessionDoc(readLegacyLog(log(PLAIN)).doc)
    expect(doc).toEqual({
      title: 'Design review',
      summary: '',
      notes: 'Hello world',
      tags: ['design'],
      speakers: [
        { id: 'c1', name: 'Sam', personId: null, confirmed: true, confidence: null, matches: [{ personId: 'p1', score: 0.75 }], introduced: null }
      ],
      // The fixture's line text differs from its original without `edited` set, so (as Lyra read
      // it) there is no overlay to rebuild: the text is kept as stored.
      transcript: [
        {
          id: 's0',
          rawId: null,
          start: 1.5,
          end: 0,
          cluster: 'c1',
          userCluster: false,
          text: 'Hi, there',
          original: 'Hi there',
          edits: [],
          edited: false,
          confidence: null
        }
      ],
      speakerSeq: 2,
      notesGenerated: null,
      notesRun: null
    })
  })
})

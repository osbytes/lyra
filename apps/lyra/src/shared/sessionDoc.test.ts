import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  ORIGIN_TRANSCRIBER,
  ORIGIN_USER,
  addTag,
  appendLiveSegment,
  applyTextChange,
  asUpdate,
  docTranscript,
  editDoc,
  initDoc,
  isUserAssigned,
  joinSplitLines,
  liveModeOf,
  mergeSpeakers,
  newSpeakerId,
  normalizeTag,
  readSegment,
  removeLiveNotes,
  removeSpeaker,
  removeTag,
  renumberSpeakers,
  replaceTranscript,
  restoreMissingSpeakers,
  setSegmentEdits,
  setSegmentText,
  setSegmentsCluster,
  snapshotOf,
  speakerToMergeInto,
  startTranscriber,
  transcriberCursor,
  transcriberWrite,
  upsertSpeaker,
  type NewSegment
} from './sessionDoc'

/** A document as main creates one: tags and speakers ready. */
function newDoc(notes = ''): Y.Doc {
  const doc = new Y.Doc()
  initDoc(doc, { title: 'Title', notes }, ORIGIN_USER)
  return doc
}

function line(id: string, cluster: string | null, start: number, end: number, text: string): NewSegment {
  return { id, rawId: null, start, end, cluster, confidence: null, text }
}

const speaker = (name: string, personId: string | null = null, confirmed = false) => ({
  name,
  personId,
  confirmed,
  confidence: null,
  matches: []
})

const names = (doc: Y.Doc): Record<string, string> =>
  Object.fromEntries(snapshotOf(doc).speakers.map((entry) => [entry.id, entry.name]))
const texts = (doc: Y.Doc): string[] => snapshotOf(doc).transcript.map((segment) => segment.text)

describe('applyTextChange', () => {
  it('changes only the middle that differs', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'hello world')
    const deltas: unknown[] = []
    text.observe((event) => deltas.push(event.delta))
    applyTextChange(text, 'hello brave world')
    expect(text.toJSON()).toBe('hello brave world')
    expect(deltas).toEqual([[{ retain: 6 }, { insert: 'brave ' }]])
  })

  it('keeps a concurrent edit elsewhere in the text', () => {
    const a = new Y.Doc()
    a.getText('t').insert(0, 'hello world')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    applyTextChange(a.getText('t'), 'Hello world')
    applyTextChange(b.getText('t'), 'hello world!')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(a.getText('t').toJSON()).toBe('Hello world!')
    expect(b.getText('t').toJSON()).toBe('Hello world!')
  })

  it('replaces a whole emoji, never half of one', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'a😀b')
    const deltas: unknown[] = []
    text.observe((event) => deltas.push(...event.delta))
    // 😀 and 😃 share their high surrogate; the change must still start before it
    applyTextChange(text, 'a😃b')
    expect(text.toJSON()).toBe('a😃b')
    expect(deltas).toEqual(expect.arrayContaining([{ retain: 1 }, { delete: 2 }, { insert: '😃' }]))
  })
})

describe('editDoc and snapshotOf', () => {
  it('sets title, summary and notes, leaving out what is not given', () => {
    const doc = newDoc('first')
    editDoc(doc, { summary: 'S', notes: 'second' }, ORIGIN_USER)
    expect(snapshotOf(doc)).toMatchObject({ title: 'Title', summary: 'S', notes: 'second', tags: [] })
  })
})

describe('tags', () => {
  it('normalizes a tag', () => {
    expect(normalizeTag('  ##Design  Review ')).toBe('design-review')
  })

  it('adds each tag once and removes it', () => {
    const doc = newDoc()
    addTag(doc, '#Design Review', ORIGIN_USER)
    addTag(doc, 'design review', ORIGIN_USER)
    addTag(doc, '   ', ORIGIN_USER)
    expect(snapshotOf(doc).tags).toEqual(['design-review'])
    removeTag(doc, 'design-review', ORIGIN_USER)
    expect(snapshotOf(doc).tags).toEqual([])
  })
})

describe('speaker ids', () => {
  it('never hands out an id again, even after its speaker is removed', () => {
    const doc = newDoc()
    expect(newSpeakerId(doc)).toBe('c0')
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'), ORIGIN_USER)
    expect(newSpeakerId(doc)).toBe('c1')
    removeSpeaker(doc, 'c0', ORIGIN_USER)
    expect(newSpeakerId(doc)).toBe('c1')
  })

  it('skips ids already used by lines in an older document', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c7', 0, 1, 'hi'), line('b', 'owner', 1, 2, 'yo')], ORIGIN_USER)
    expect(newSpeakerId(doc)).toBe('c8')
  })
})

describe('upsertSpeaker', () => {
  it('keeps the fields an update leaves out', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Ana', 'p1'), ORIGIN_USER)
    upsertSpeaker(doc, 'c0', { confirmed: true, matches: [{ personId: 'p1', score: 0.9 }] }, ORIGIN_USER)
    expect(snapshotOf(doc).speakers).toEqual([
      {
        id: 'c0',
        name: 'Ana',
        personId: 'p1',
        confirmed: true,
        confidence: null,
        matches: [{ personId: 'p1', score: 0.9 }]
      }
    ])
  })
})

describe('speakerToMergeInto', () => {
  it('finds another speaker with the same saved person or the same name', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Ana', 'p1'), ORIGIN_USER)
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'), ORIGIN_USER)
    expect(speakerToMergeInto(doc, 'c1', ' ana ', null)).toBe('c0')
    expect(speakerToMergeInto(doc, 'c1', 'Bob', 'p1')).toBe('c0')
    expect(speakerToMergeInto(doc, 'c1', 'Bob', null)).toBeNull()
    expect(speakerToMergeInto(doc, 'c0', 'Ana', 'p1')).toBeNull()
  })
})

describe('mergeSpeakers', () => {
  it('moves every line to the other speaker and removes the first', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'), ORIGIN_USER)
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'), ORIGIN_USER)
    replaceTranscript(doc, [line('a', 'c0', 0, 1, 'hi'), line('b', 'c1', 1, 2, 'yo')], ORIGIN_USER)
    mergeSpeakers(doc, 'c1', 'c0', ORIGIN_USER)
    const snapshot = snapshotOf(doc)
    expect(snapshot.transcript.map((segment) => segment.cluster)).toEqual(['c0', 'c0'])
    expect(snapshot.speakers.map((entry) => entry.id)).toEqual(['c0'])
    expect(newSpeakerId(doc)).toBe('c2')
  })
})

describe('renumberSpeakers', () => {
  it('numbers placeholders by first appearance, around names the user gave', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 2'), ORIGIN_USER)
    upsertSpeaker(doc, 'c1', speaker('Speaker 5'), ORIGIN_USER)
    upsertSpeaker(doc, 'c2', speaker('Ana'), ORIGIN_USER)
    upsertSpeaker(doc, 'c3', speaker('Speaker 1', null, true), ORIGIN_USER)
    replaceTranscript(
      doc,
      [line('a', 'c1', 0, 1, 'one'), line('b', 'c2', 1, 2, 'two'), line('c', 'c0', 2, 3, 'three'), line('d', 'c3', 3, 4, 'four')],
      ORIGIN_USER
    )
    renumberSpeakers(doc, ORIGIN_USER)
    // "Speaker 1" is a confirmed name, so the first placeholder becomes Speaker 2
    expect(names(doc)).toEqual({ c0: 'Speaker 3', c1: 'Speaker 2', c2: 'Ana', c3: 'Speaker 1' })
  })
})

describe('restoreMissingSpeakers', () => {
  it('gives a line whose speaker is gone a placeholder speaker', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'), ORIGIN_USER)
    replaceTranscript(doc, [line('a', 'c0', 0, 1, 'hi'), line('b', 'c1', 1, 2, 'yo')], ORIGIN_USER)
    expect(restoreMissingSpeakers(doc, ORIGIN_USER)).toBe(1)
    expect(names(doc)).toEqual({ c0: 'Speaker 1', c1: 'Speaker 2' })
    expect(restoreMissingSpeakers(doc, ORIGIN_USER)).toBe(0)
  })
})

describe('readSegment', () => {
  it('reads a line edited before the overlay existed as one correction', () => {
    const doc = newDoc()
    const entry = new Y.Map<unknown>()
    entry.set('id', 'old')
    entry.set('text', new Y.Text('the dog sat'))
    entry.set('original', 'the cat sat')
    entry.set('edited', true)
    docTranscript(doc).push([entry])
    expect(readSegment(entry).edits).toEqual([{ kind: 'replace', start: 4, end: 7, text: 'dog' }])
  })

  it('falls back on malformed fields', () => {
    const doc = newDoc()
    const entry = new Y.Map<unknown>()
    entry.set('id', 'x')
    entry.set('start', 'soon')
    entry.set('end', Number.NaN)
    entry.set('rawId', 5)
    entry.set('confidence', Number.POSITIVE_INFINITY)
    entry.set('text', new Y.Text('heard'))
    docTranscript(doc).push([entry])
    expect(readSegment(entry)).toEqual({
      id: 'x',
      rawId: null,
      start: 0,
      end: 0,
      cluster: null,
      userCluster: false,
      text: 'heard',
      original: 'heard',
      edits: [],
      edited: false,
      confidence: null
    })
  })
})

describe('line edits', () => {
  it('stores a rewrite as a correction and keeps the original', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')], ORIGIN_USER)
    setSegmentText(doc, 'a', 'hello their', ORIGIN_USER)
    expect(snapshotOf(doc).transcript[0]).toMatchObject({
      text: 'hello their',
      original: 'hello there',
      edited: true,
      edits: [{ kind: 'replace', start: 6, end: 11, text: 'their' }]
    })
  })

  it('does not count a highlight alone as an edit', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')], ORIGIN_USER)
    setSegmentEdits(doc, 'a', [{ kind: 'highlight', start: 0, end: 5 }], ORIGIN_USER)
    expect(snapshotOf(doc).transcript[0]).toMatchObject({ text: 'hello there', edited: false })
  })
})

describe('replaceTranscript', () => {
  it('leaves leading lines the pass did not change in place, and rewrites from the first that did', () => {
    const doc = newDoc()
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', null, 2, 4, 'general kenobi'), line('c', null, 4, 5, 'so')],
      ORIGIN_USER
    )
    const before = docTranscript(doc).toArray()
    // The same first line; the second now has a speaker; the third is as it was, but follows it.
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', 'c1', 2, 4, 'general kenobi'), line('c', null, 4, 5, 'so')],
      ORIGIN_USER
    )
    const after = docTranscript(doc).toArray()
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(snapshotOf(doc).transcript.map((entry) => [entry.id, entry.cluster])).toEqual([
      ['a', 'c0'],
      ['b', 'c1'],
      ['c', null]
    ])
    // A pass with fewer lines drops the rest.
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')], ORIGIN_USER)
    expect(docTranscript(doc).toArray()).toHaveLength(1)
    expect(docTranscript(doc).get(0)).toBe(before[0])
  })

  it('keeps the user’s edit on the new line over the same audio', () => {
    const doc = newDoc()
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', 'c0', 2, 4, 'general kenobi')],
      ORIGIN_USER
    )
    setSegmentText(doc, 'a', 'hello their', ORIGIN_USER)
    // the new pass relabels and re-times: "a" overlaps x by 1.8 s of x's 1.9
    replaceTranscript(
      doc,
      [line('x', 'c1', 0.2, 2.1, 'hallo there'), line('y', 'c2', 2, 4, 'general kenobi again')],
      ORIGIN_USER
    )
    const [first, second] = snapshotOf(doc).transcript
    expect(first).toMatchObject({
      id: 'x',
      cluster: 'c1',
      start: 0.2,
      text: 'hello their',
      original: 'hello there',
      edited: true
    })
    expect(second).toMatchObject({ id: 'y', text: 'general kenobi again', edited: false, edits: [] })
  })

  it('drops an edit when no new line covers most of its audio', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')], ORIGIN_USER)
    setSegmentText(doc, 'a', 'hello their', ORIGIN_USER)
    replaceTranscript(doc, [line('x', 'c0', 1.5, 4, 'there and more')], ORIGIN_USER)
    expect(snapshotOf(doc).transcript[0]).toMatchObject({ text: 'there and more', edited: false })
  })
})

describe('appendLiveSegment', () => {
  const limits = { joinGap: 1.5, maxLine: 30 }

  it('extends the last line of the same speaker and starts a new one otherwise', () => {
    const doc = newDoc()
    appendLiveSegment(doc, { ...line('s1', 'c0', 0, 2, 'hello there.'), confidence: 0.9 }, limits, ORIGIN_TRANSCRIBER)
    appendLiveSegment(doc, { ...line('s2', 'c0', 2.5, 4, 'how are you'), confidence: 0.7 }, limits, ORIGIN_TRANSCRIBER)
    appendLiveSegment(doc, line('s3', 'c1', 4, 5, 'fine'), limits, ORIGIN_TRANSCRIBER)
    // 4 s after the last line: too long a pause to be the same turn
    appendLiveSegment(doc, line('s4', 'c1', 9, 10, 'thanks'), limits, ORIGIN_TRANSCRIBER)
    const transcript = snapshotOf(doc).transcript
    expect(transcript.map((segment) => segment.text)).toEqual(['Hello there. How are you', 'Fine', 'Thanks'])
    expect(transcript[0]).toMatchObject({ start: 0, end: 4, confidence: 0.7, original: 'Hello there. How are you' })
  })

  it('never extends a line the user edited', () => {
    const doc = newDoc()
    appendLiveSegment(doc, line('s1', 'c0', 0, 2, 'hello there'), limits, ORIGIN_TRANSCRIBER)
    setSegmentText(doc, 's1', 'hello their', ORIGIN_USER)
    appendLiveSegment(doc, line('s2', 'c0', 2, 3, 'friend'), limits, ORIGIN_TRANSCRIBER)
    expect(texts(doc)).toEqual(['hello their', 'Friend'])
  })
})

describe('joinSplitLines', () => {
  const split = [
    line('a', 'c0', 0, 2, 'We should meet for the weekly'),
    line('b', 'c0', 2, 4, 'Planning meeting.'),
    line('c', 'c1', 4, 6, 'Sure.'),
    line('d', 'c1', 6, 8, 'Sounds good.')
  ]

  it('rejoins one speaker’s consecutive lines, continuing a sentence in lowercase', () => {
    const doc = newDoc()
    replaceTranscript(doc, split, ORIGIN_USER)
    joinSplitLines(doc, 30, ORIGIN_USER)
    expect(texts(doc)).toEqual(['We should meet for the weekly planning meeting.', 'Sure. Sounds good.'])
    expect(snapshotOf(doc).transcript.map((segment) => segment.end)).toEqual([4, 8])
  })

  it('leaves edited lines and lines that would grow past maxLine apart', () => {
    const doc = newDoc()
    replaceTranscript(doc, split, ORIGIN_USER)
    setSegmentText(doc, 'b', 'Planning meetings.', ORIGIN_USER)
    joinSplitLines(doc, 3, ORIGIN_USER)
    expect(texts(doc)).toHaveLength(4)
  })
})

describe('live notes', () => {
  it('writes at its own cursor and takes its text back out after the user typed around it', () => {
    const doc = newDoc('My notes')
    expect(liveModeOf(doc)).toBeNull()
    startTranscriber(doc, ORIGIN_TRANSCRIBER)
    expect(liveModeOf(doc)).toBe('notes')
    transcriberWrite(doc, '\n\nHello world', ORIGIN_TRANSCRIBER)
    editDoc(doc, { notes: 'Top. My notes\n\nHello world' }, ORIGIN_USER)
    expect(transcriberCursor(doc)).toBe('Top. My notes\n\nHello world'.length)
    expect(removeLiveNotes(doc, ORIGIN_USER)).toBe(1)
    expect(snapshotOf(doc).notes).toBe('Top. My notes')
    expect(liveModeOf(doc)).toBeNull()
  })

  it('leaves transcribed text the user edited', () => {
    const doc = newDoc('My notes')
    startTranscriber(doc, ORIGIN_TRANSCRIBER, 'transcript')
    expect(liveModeOf(doc)).toBe('transcript')
    transcriberWrite(doc, ' Hello world', ORIGIN_TRANSCRIBER)
    editDoc(doc, { notes: 'My notes Hello brave world' }, ORIGIN_USER)
    expect(removeLiveNotes(doc, ORIGIN_USER)).toBe(0)
    expect(snapshotOf(doc).notes).toBe('My notes Hello brave world')
  })
})

describe('asUpdate', () => {
  it('accepts the binary shapes IPC and disk deliver, and refuses anything else', () => {
    const doc = newDoc('notes')
    const update = Y.encodeStateAsUpdate(doc)
    expect(asUpdate(update)).toBe(update)
    const copy = new Uint8Array(update)
    const fromBuffer = asUpdate(copy.buffer)
    expect([...fromBuffer]).toEqual([...update])
    const padded = new Uint8Array(update.length + 4)
    padded.set(update, 2)
    const view = asUpdate(new DataView(padded.buffer, 2, update.length))
    expect([...view]).toEqual([...update])
    const replica = new Y.Doc()
    Y.applyUpdate(replica, view)
    expect(snapshotOf(replica).notes).toBe('notes')
    expect(() => asUpdate('not binary')).toThrow(/binary/)
    expect(() => asUpdate([1, 2, 3])).toThrow(/binary/)
  })
})

describe('the user\'s choice of speaker', () => {
  const ORIGIN_RELABEL = 'relabel'
  const live = { joinGap: 8, maxLine: 30 }

  /** A call heard live: two lines on the mic, before any relabel. */
  function liveCall(): Y.Doc {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Me'), ORIGIN_TRANSCRIBER)
    upsertSpeaker(doc, 'c1', speaker('Remote'), ORIGIN_TRANSCRIBER)
    appendLiveSegment(doc, line('live-mic-0', 'c0', 0, 4, 'Hello there.'), live, ORIGIN_TRANSCRIBER)
    appendLiveSegment(doc, line('live-sys-20', 'c1', 20, 24, 'Hi back.'), live, ORIGIN_TRANSCRIBER)
    return doc
  }
  const clusters = (doc: Y.Doc): (string | null)[] => snapshotOf(doc).transcript.map((entry) => entry.cluster)

  it('survives a new pass over a live line the user moved', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', ORIGIN_USER)
    expect(isUserAssigned(doc, 'live-mic-0')).toBe(true)
    expect(isUserAssigned(doc, 'live-sys-20')).toBe(false)
    // The new pass heard the first line as c0; the user said it's c1.
    replaceTranscript(
      doc,
      [{ ...line('pass-1-s0', 'c0', 0.2, 4, 'Hello there.'), rawId: 'pass-1-s0' }, line('pass-1-s1', 'c1', 20, 24, 'Hi back.')],
      ORIGIN_RELABEL
    )
    const [first, second] = snapshotOf(doc).transcript
    expect(first).toMatchObject({ id: 'pass-1-s0', cluster: 'c1', userCluster: true, text: 'Hello there.', edited: false })
    expect(second).toMatchObject({ cluster: 'c1', userCluster: false })
    // And the one after it.
    replaceTranscript(doc, [line('pass-2-s0', 'c0', 0, 4, 'Hello there.')], ORIGIN_RELABEL)
    expect(clusters(doc)).toEqual(['c1'])
  })

  it('keeps the new pass\'s words while keeping the user\'s speaker', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', ORIGIN_USER)
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello, there.')], ORIGIN_RELABEL)
    expect(snapshotOf(doc).transcript[0]).toMatchObject({ cluster: 'c1', text: 'Hello, there.', original: 'Hello, there.' })
  })

  it('lets a new pass relabel a line once the user\'s speaker is gone', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', ORIGIN_USER)
    removeSpeaker(doc, 'c1', ORIGIN_USER)
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello there.')], ORIGIN_RELABEL)
    expect(snapshotOf(doc).transcript[0]).toMatchObject({ cluster: 'c0', userCluster: false })
  })

  it('is not set by a machine writer, and a new pass takes its speaker over an unmarked line', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', ORIGIN_RELABEL)
    setSegmentsCluster(doc, ['live-sys-20'], 'c0', ORIGIN_TRANSCRIBER)
    expect(snapshotOf(doc).transcript.map((entry) => entry.userCluster)).toEqual([false, false])
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello there.')], ORIGIN_RELABEL)
    expect(clusters(doc)).toEqual(['c0'])
  })

  it('is set by a pass that kept the user\'s choice for its words', () => {
    const doc = liveCall()
    replaceTranscript(doc, [{ ...line('pass-1-s0', 'c1', 0, 4, 'Hello there.'), userCluster: true }], ORIGIN_RELABEL)
    expect(isUserAssigned(doc, 'pass-1-s0')).toBe(true)
  })

  it('is set on the lines a merge moves, and kept on lines already marked', () => {
    const doc = liveCall()
    upsertSpeaker(doc, 'c2', speaker('Speaker 3'), ORIGIN_TRANSCRIBER)
    appendLiveSegment(doc, line('live-mic-40', 'c2', 40, 42, 'Third.'), live, ORIGIN_TRANSCRIBER)
    setSegmentsCluster(doc, ['live-sys-20'], 'c2', ORIGIN_USER)
    mergeSpeakers(doc, 'c2', 'c0', ORIGIN_USER)
    expect(clusters(doc)).toEqual(['c0', 'c0', 'c0'])
    expect(snapshotOf(doc).transcript.map((entry) => entry.userCluster)).toEqual([false, true, true])
    // A machine merge moves lines without claiming them for the user.
    const other = liveCall()
    mergeSpeakers(other, 'c1', 'c0', ORIGIN_RELABEL)
    expect(snapshotOf(other).transcript.map((entry) => entry.userCluster)).toEqual([false, false])
  })

  it('keeps live words that follow from joining a line the user assigned', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-sys-20'], 'c1', ORIGIN_USER)
    appendLiveSegment(doc, line('live-sys-25', 'c1', 25, 27, 'More words.'), live, ORIGIN_TRANSCRIBER)
    expect(texts(doc)).toEqual(['Hello there.', 'Hi back.', 'More words.'])
    expect(snapshotOf(doc).transcript.map((entry) => entry.userCluster)).toEqual([false, true, false])
  })

  it('reaches a replica, and undoing the move takes it back', () => {
    const doc = liveCall()
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    const undo = new Y.UndoManager(docTranscript(replica), { trackedOrigins: new Set([ORIGIN_USER]) })
    setSegmentsCluster(replica, ['live-mic-0'], 'c1', ORIGIN_USER)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc)))
    expect(isUserAssigned(doc, 'live-mic-0')).toBe(true)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    expect(snapshotOf(copy).transcript[0]).toMatchObject({ cluster: 'c1', userCluster: true })
    undo.undo()
    expect(snapshotOf(replica).transcript[0]).toMatchObject({ cluster: 'c0', userCluster: false })
  })

  it('reads as unassigned on documents from before the mark', () => {
    const doc = liveCall()
    expect(readSegment(docTranscript(doc).get(0)).userCluster).toBe(false)
  })
})

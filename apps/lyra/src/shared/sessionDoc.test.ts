import { describe, expect, it } from 'vitest'
import {
  addTag,
  appendLiveSegment,
  applyOp,
  changedFields,
  copyDoc,
  editDoc,
  emptyDoc,
  invertPatch,
  isUserAssigned,
  joinSplitLines,
  mergeSpeakers,
  newSpeakerId,
  normalizeTag,
  patchBetween,
  removeSpeaker,
  removeTag,
  renumberSpeakers,
  replaceTranscript,
  restoreMissingSpeakers,
  setSegmentEdits,
  setSegmentsCluster,
  setSegmentText,
  speakerToMergeInto,
  splitLineSpeaker,
  upsertSpeaker,
  type NewSegment,
  type SessionDoc,
  type SessionOp
} from './sessionDoc'

function newDoc(notes = ''): SessionDoc {
  return emptyDoc({ title: 'Title', notes })
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

const names = (doc: SessionDoc): Record<string, string> =>
  Object.fromEntries(doc.speakers.map((entry) => [entry.id, entry.name]))
const texts = (doc: SessionDoc): string[] => doc.transcript.map((segment) => segment.text)

describe('editDoc', () => {
  it('sets title, summary and notes, leaving out what is not given', () => {
    const doc = newDoc('first')
    editDoc(doc, { summary: 'S', notes: 'second' })
    expect(doc).toMatchObject({ title: 'Title', summary: 'S', notes: 'second', tags: [] })
  })
})

describe('tags', () => {
  it('normalizes a tag', () => {
    expect(normalizeTag('  ##Design  Review ')).toBe('design-review')
  })

  it('adds each tag once and removes it', () => {
    const doc = newDoc()
    addTag(doc, '#Design Review')
    addTag(doc, 'design review')
    addTag(doc, '   ')
    expect(doc.tags).toEqual(['design-review'])
    removeTag(doc, 'design-review')
    expect(doc.tags).toEqual([])
  })
})

describe('speaker ids', () => {
  it('never hands out an id again, even after its speaker is removed', () => {
    const doc = newDoc()
    expect(newSpeakerId(doc)).toBe('c0')
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    expect(newSpeakerId(doc)).toBe('c1')
    removeSpeaker(doc, 'c0')
    expect(newSpeakerId(doc)).toBe('c1')
  })

  it('skips ids already used by lines in an older document', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c7', 0, 1, 'hi'), line('b', 'owner', 1, 2, 'yo')])
    expect(newSpeakerId(doc)).toBe('c8')
  })
})

describe('upsertSpeaker', () => {
  it('keeps the fields an update leaves out', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Ana', 'p1'))
    upsertSpeaker(doc, 'c0', { confirmed: true, matches: [{ personId: 'p1', score: 0.9 }] })
    expect(doc.speakers).toEqual([
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
    upsertSpeaker(doc, 'c0', speaker('Ana', 'p1'))
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'))
    expect(speakerToMergeInto(doc, 'c1', ' ana ', null)).toBe('c0')
    expect(speakerToMergeInto(doc, 'c1', 'Bob', 'p1')).toBe('c0')
    expect(speakerToMergeInto(doc, 'c1', 'Bob', null)).toBeNull()
    expect(speakerToMergeInto(doc, 'c0', 'Ana', 'p1')).toBeNull()
  })
})

describe('mergeSpeakers', () => {
  it('moves every line to the other speaker and removes the first', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'))
    replaceTranscript(doc, [line('a', 'c0', 0, 1, 'hi'), line('b', 'c1', 1, 2, 'yo')])
    mergeSpeakers(doc, 'c1', 'c0', true)
    const snapshot = doc
    expect(snapshot.transcript.map((segment) => segment.cluster)).toEqual(['c0', 'c0'])
    expect(snapshot.speakers.map((entry) => entry.id)).toEqual(['c0'])
    expect(newSpeakerId(doc)).toBe('c2')
  })
})

describe('renumberSpeakers', () => {
  it('numbers placeholders by first appearance, around names the user gave', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 2'))
    upsertSpeaker(doc, 'c1', speaker('Speaker 5'))
    upsertSpeaker(doc, 'c2', speaker('Ana'))
    upsertSpeaker(doc, 'c3', speaker('Speaker 1', null, true))
    replaceTranscript(
      doc,
      [line('a', 'c1', 0, 1, 'one'), line('b', 'c2', 1, 2, 'two'), line('c', 'c0', 2, 3, 'three'), line('d', 'c3', 3, 4, 'four')])
    renumberSpeakers(doc)
    // "Speaker 1" is a confirmed name, so the first placeholder becomes Speaker 2
    expect(names(doc)).toEqual({ c0: 'Speaker 3', c1: 'Speaker 2', c2: 'Ana', c3: 'Speaker 1' })
  })
})

describe('restoreMissingSpeakers', () => {
  it('gives a line whose speaker is gone a placeholder speaker', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    replaceTranscript(doc, [line('a', 'c0', 0, 1, 'hi'), line('b', 'c1', 1, 2, 'yo')])
    expect(restoreMissingSpeakers(doc)).toBe(1)
    expect(names(doc)).toEqual({ c0: 'Speaker 1', c1: 'Speaker 2' })
    expect(restoreMissingSpeakers(doc)).toBe(0)
  })
})

describe('line edits', () => {
  it('stores a rewrite as a correction and keeps the original', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')])
    setSegmentText(doc, 'a', 'hello their')
    expect(doc.transcript[0]).toMatchObject({
      text: 'hello their',
      original: 'hello there',
      edited: true,
      edits: [{ kind: 'replace', start: 6, end: 11, text: 'their' }]
    })
  })

  it('does not count a highlight alone as an edit', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')])
    setSegmentEdits(doc, 'a', [{ kind: 'highlight', start: 0, end: 5 }])
    expect(doc.transcript[0]).toMatchObject({ text: 'hello there', edited: false })
  })
})

describe('replaceTranscript', () => {
  it('leaves leading lines the pass did not change in place, and rewrites from the first that did', () => {
    const doc = newDoc()
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', null, 2, 4, 'general kenobi'), line('c', null, 4, 5, 'so')])
    const before = doc.transcript
    // The same first line; the second now has a speaker; the third is as it was, but follows it.
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', 'c1', 2, 4, 'general kenobi'), line('c', null, 4, 5, 'so')])
    const after = doc.transcript
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(doc.transcript.map((entry) => [entry.id, entry.cluster])).toEqual([
      ['a', 'c0'],
      ['b', 'c1'],
      ['c', null]
    ])
    // A pass with fewer lines drops the rest.
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')])
    expect(doc.transcript).toHaveLength(1)
    expect(doc.transcript[0]).toBe(before[0])
  })

  it('keeps the user’s edit on the new line over the same audio', () => {
    const doc = newDoc()
    replaceTranscript(
      doc,
      [line('a', 'c0', 0, 2, 'hello there'), line('b', 'c0', 2, 4, 'general kenobi')])
    setSegmentText(doc, 'a', 'hello their')
    // the new pass relabels and re-times: "a" overlaps x by 1.8 s of x's 1.9
    replaceTranscript(
      doc,
      [line('x', 'c1', 0.2, 2.1, 'hallo there'), line('y', 'c2', 2, 4, 'general kenobi again')])
    const [first, second] = doc.transcript
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
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there')])
    setSegmentText(doc, 'a', 'hello their')
    replaceTranscript(doc, [line('x', 'c0', 1.5, 4, 'there and more')])
    expect(doc.transcript[0]).toMatchObject({ text: 'there and more', edited: false })
  })
})

describe('appendLiveSegment', () => {
  const limits = { joinGap: 1.5, maxLine: 30 }

  it('extends the last line of the same speaker and starts a new one otherwise', () => {
    const doc = newDoc()
    appendLiveSegment(doc, { ...line('s1', 'c0', 0, 2, 'hello there.'), confidence: 0.9 }, limits)
    appendLiveSegment(doc, { ...line('s2', 'c0', 2.5, 4, 'how are you'), confidence: 0.7 }, limits)
    appendLiveSegment(doc, line('s3', 'c1', 4, 5, 'fine'), limits)
    // 4 s after the last line: too long a pause to be the same turn
    appendLiveSegment(doc, line('s4', 'c1', 9, 10, 'thanks'), limits)
    const transcript = doc.transcript
    expect(transcript.map((segment) => segment.text)).toEqual(['Hello there. How are you', 'Fine', 'Thanks'])
    expect(transcript[0]).toMatchObject({ start: 0, end: 4, confidence: 0.7, original: 'Hello there. How are you' })
  })

  it('never extends a line the user edited', () => {
    const doc = newDoc()
    appendLiveSegment(doc, line('s1', 'c0', 0, 2, 'hello there'), limits)
    setSegmentText(doc, 's1', 'hello their')
    appendLiveSegment(doc, line('s2', 'c0', 2, 3, 'friend'), limits)
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
    replaceTranscript(doc, split)
    joinSplitLines(doc, 30)
    expect(texts(doc)).toEqual(['We should meet for the weekly planning meeting.', 'Sure. Sounds good.'])
    expect(doc.transcript.map((segment) => segment.end)).toEqual([4, 8])
  })

  it('leaves edited lines and lines that would grow past maxLine apart', () => {
    const doc = newDoc()
    replaceTranscript(doc, split)
    setSegmentText(doc, 'b', 'Planning meetings.')
    joinSplitLines(doc, 3)
    expect(texts(doc)).toHaveLength(4)
  })
})

describe('the user\'s choice of speaker', () => {
  const live = { joinGap: 8, maxLine: 30 }

  /** A call heard live: two lines on the mic, before any relabel. */
  function liveCall(): SessionDoc {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Me'))
    upsertSpeaker(doc, 'c1', speaker('Remote'))
    appendLiveSegment(doc, line('live-mic-0', 'c0', 0, 4, 'Hello there.'), live)
    appendLiveSegment(doc, line('live-sys-20', 'c1', 20, 24, 'Hi back.'), live)
    return doc
  }
  const clusters = (doc: SessionDoc): (string | null)[] => doc.transcript.map((entry) => entry.cluster)

  it('survives a new pass over a live line the user moved', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', true)
    expect(isUserAssigned(doc, 'live-mic-0')).toBe(true)
    expect(isUserAssigned(doc, 'live-sys-20')).toBe(false)
    // The new pass heard the first line as c0; the user said it's c1.
    replaceTranscript(
      doc,
      [{ ...line('pass-1-s0', 'c0', 0.2, 4, 'Hello there.'), rawId: 'pass-1-s0' }, line('pass-1-s1', 'c1', 20, 24, 'Hi back.')])
    const [first, second] = doc.transcript
    expect(first).toMatchObject({ id: 'pass-1-s0', cluster: 'c1', userCluster: true, text: 'Hello there.', edited: false })
    expect(second).toMatchObject({ cluster: 'c1', userCluster: false })
    // And the one after it.
    replaceTranscript(doc, [line('pass-2-s0', 'c0', 0, 4, 'Hello there.')])
    expect(clusters(doc)).toEqual(['c1'])
  })

  it('keeps the new pass\'s words while keeping the user\'s speaker', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', true)
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello, there.')])
    expect(doc.transcript[0]).toMatchObject({ cluster: 'c1', text: 'Hello, there.', original: 'Hello, there.' })
  })

  it('lets a new pass relabel a line once the user\'s speaker is gone', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', true)
    removeSpeaker(doc, 'c1')
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello there.')])
    expect(doc.transcript[0]).toMatchObject({ cluster: 'c0', userCluster: false })
  })

  it('is not set by a machine writer, and a new pass takes its speaker over an unmarked line', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-mic-0'], 'c1', false)
    setSegmentsCluster(doc, ['live-sys-20'], 'c0', false)
    expect(doc.transcript.map((entry) => entry.userCluster)).toEqual([false, false])
    replaceTranscript(doc, [line('pass-1-s0', 'c0', 0, 4, 'Hello there.')])
    expect(clusters(doc)).toEqual(['c0'])
  })

  it('is set by a pass that kept the user\'s choice for its words', () => {
    const doc = liveCall()
    replaceTranscript(doc, [{ ...line('pass-1-s0', 'c1', 0, 4, 'Hello there.'), userCluster: true }])
    expect(isUserAssigned(doc, 'pass-1-s0')).toBe(true)
  })

  it('is set on the lines a merge moves, and kept on lines already marked', () => {
    const doc = liveCall()
    upsertSpeaker(doc, 'c2', speaker('Speaker 3'))
    appendLiveSegment(doc, line('live-mic-40', 'c2', 40, 42, 'Third.'), live)
    setSegmentsCluster(doc, ['live-sys-20'], 'c2', true)
    mergeSpeakers(doc, 'c2', 'c0', true)
    expect(clusters(doc)).toEqual(['c0', 'c0', 'c0'])
    expect(doc.transcript.map((entry) => entry.userCluster)).toEqual([false, true, true])
    // A machine merge moves lines without claiming them for the user.
    const other = liveCall()
    mergeSpeakers(other, 'c1', 'c0', false)
    expect(other.transcript.map((entry) => entry.userCluster)).toEqual([false, false])
  })

  it('keeps live words that follow from joining a line the user assigned', () => {
    const doc = liveCall()
    setSegmentsCluster(doc, ['live-sys-20'], 'c1', true)
    appendLiveSegment(doc, line('live-sys-25', 'c1', 25, 27, 'More words.'), live)
    expect(texts(doc)).toEqual(['Hello there.', 'Hi back.', 'More words.'])
    expect(doc.transcript.map((entry) => entry.userCluster)).toEqual([false, true, false])
  })
})

describe('applyOp', () => {
  /** Two speakers, two lines, and one line of each. */
  function meeting(): SessionDoc {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'))
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello there'), line('b', 'c1', 2, 4, 'hi')])
    return doc
  }

  it('applies a window\'s edits', () => {
    const doc = meeting()
    const ops: SessionOp[] = [
      { op: 'title', title: 'Sync' },
      { op: 'notes', notes: 'Agenda' },
      { op: 'summary', summary: 'We met.' },
      { op: 'tag', tag: '#Team' },
      { op: 'lineText', id: 'a', text: 'hello their' },
      { op: 'assign', ids: ['b'], speaker: 'c2', create: { name: 'Ana', personId: null, confirmed: true } }
    ]
    for (const op of ops) applyOp(doc, op)
    expect(doc).toMatchObject({ title: 'Sync', notes: 'Agenda', summary: 'We met.', tags: ['team'] })
    expect(doc.transcript.map((entry) => [entry.id, entry.cluster, entry.text, entry.userCluster])).toEqual([
      ['a', 'c0', 'hello their', false],
      ['b', 'c2', 'hi', true]
    ])
    expect(names(doc)).toEqual({ c0: 'Speaker 1', c1: 'Speaker 2', c2: 'Ana' })
    expect(newSpeakerId(doc)).toBe('c3')
  })

  it('changes nothing more when applied twice', () => {
    const doc = meeting()
    const ops: SessionOp[] = [
      { op: 'tag', tag: 'team' },
      { op: 'lineEdits', id: 'a', edits: [{ kind: 'delete', start: 0, end: 6 }] },
      { op: 'name', id: 'c1', name: 'Ana', personId: null }
    ]
    for (const op of ops) applyOp(doc, op)
    const once = copyDoc(doc)
    for (const op of ops) applyOp(doc, op)
    expect(doc).toEqual(once)
    expect(doc.transcript[0]?.text).toBe('there')
  })

  it('names a speaker into another with the same name, as the user\'s choice', () => {
    const doc = meeting()
    applyOp(doc, { op: 'name', id: 'c0', name: 'Ana', personId: null })
    applyOp(doc, { op: 'name', id: 'c1', name: 'ana', personId: null })
    expect(doc.speakers.map((entry) => [entry.id, entry.name, entry.confirmed])).toEqual([['c0', 'ana', true]])
    expect(doc.transcript.map((entry) => [entry.cluster, entry.userCluster])).toEqual([
      ['c0', false],
      ['c0', true]
    ])
  })

  it('drops edits past the end of a line', () => {
    const doc = meeting()
    applyOp(doc, { op: 'lineEdits', id: 'b', edits: [{ kind: 'delete', start: 0, end: 9 }] })
    expect(doc.transcript[1]).toMatchObject({ text: 'hi', edits: [], edited: false })
  })
})

describe('splitLineSpeaker', () => {
  function oneLine(): SessionDoc {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    upsertSpeaker(doc, 'c1', speaker('Speaker 2'))
    // 20 characters over 10 seconds: two characters a second.
    replaceTranscript(doc, [{ ...line('a', 'c0', 10, 20, 'one two three four f'), rawId: 'r0', confidence: 0.9 }])
    return doc
  }
  const rows = (doc: SessionDoc) =>
    doc.transcript.map((entry) => [entry.id, entry.cluster, entry.userCluster, entry.text, entry.start, entry.end])

  it('gives the middle of a line to another speaker, sharing out its time by length', () => {
    const doc = oneLine()
    // "two three " (4–14): the space after it stays with nobody.
    splitLineSpeaker(doc, 'a', { start: 4, end: 14 }, 'c1')
    expect(rows(doc)).toEqual([
      ['a.0', 'c0', false, 'one', 10, 12],
      ['a.4', 'c1', true, 'two three', 12, 17],
      ['a.14', 'c0', false, 'four f', 17, 20]
    ])
    // The moved words no longer stand for the pass's line; the rest still do.
    expect(doc.transcript.map((entry) => [entry.rawId, entry.confidence])).toEqual([
      ['r0', 0.9],
      [null, null],
      ['r0', 0.9]
    ])
  })

  it('splits once when the words start or end the line', () => {
    const doc = oneLine()
    splitLineSpeaker(doc, 'a', { start: 0, end: 7 }, 'c1')
    expect(doc.transcript.map((entry) => [entry.id, entry.cluster, entry.text])).toEqual([
      ['a.0', 'c1', 'one two'],
      ['a.8', 'c0', 'three four f']
    ])
  })

  it('keeps punctuation with the words it ends', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', 'c0', 0, 4, 'Is it on, or off?')])
    splitLineSpeaker(doc, 'a', { start: 10, end: 16 }, 'c1')
    expect(doc.transcript.map((entry) => [entry.cluster, entry.text])).toEqual([
      ['c0', 'Is it on,'],
      ['c1', 'or off?']
    ])
  })

  it('moves the whole line in place when every word is chosen', () => {
    const doc = oneLine()
    splitLineSpeaker(doc, 'a', { start: 0, end: 20 }, 'c1')
    expect(rows(doc)).toEqual([['a', 'c1', true, 'one two three four f', 10, 20]])
  })

  it('carries edits into the piece they fall in, whole', () => {
    const doc = oneLine()
    setSegmentEdits(doc, 'a', [
      { kind: 'replace', start: 4, end: 7, text: 'too' },
      { kind: 'highlight', start: 0, end: 13 }
    ])
    // The selection starts inside the correction: it takes all of it.
    splitLineSpeaker(doc, 'a', { start: 5, end: 13 }, 'c1')
    expect(doc.transcript.map((entry) => [entry.text, entry.edits, entry.edited])).toEqual([
      ['one', [{ kind: 'highlight', start: 0, end: 3 }], false],
      [
        'too three',
        [
          { kind: 'replace', start: 0, end: 3, text: 'too' },
          { kind: 'highlight', start: 0, end: 9 }
        ],
        true
      ],
      ['four f', [], false]
    ])
  })

  it('creates the speaker, changes nothing when applied twice, and undoes', () => {
    const doc = oneLine()
    const before = copyDoc(doc)
    const op: SessionOp = {
      op: 'splitLine',
      id: 'a',
      start: 4,
      end: 13,
      speaker: 'c2',
      create: { name: 'Ana', personId: null, confirmed: true }
    }
    applyOp(doc, op)
    const once = copyDoc(doc)
    applyOp(doc, op)
    expect(doc).toEqual(once)
    expect(names(doc)).toMatchObject({ c2: 'Ana' })
    const patch = patchBetween(before, doc)
    if (!patch) throw new Error('no patch')
    applyOp(doc, { op: 'restore', patch: invertPatch(patch) })
    expect(doc.transcript).toEqual(before.transcript)
    expect(doc.speakers).toEqual(before.speakers)
    applyOp(doc, { op: 'restore', patch })
    expect(doc.transcript).toEqual(once.transcript)
  })

  it('ignores a span of only spaces, or a line that is gone', () => {
    const doc = oneLine()
    const before = copyDoc(doc)
    splitLineSpeaker(doc, 'a', { start: 3, end: 4 }, 'c1')
    splitLineSpeaker(doc, 'gone', { start: 0, end: 3 }, 'c1')
    expect(doc).toEqual(before)
  })
})

describe('undo patches', () => {
  /** What a window does: apply an edit, keep the patch that takes it back. */
  function edit(doc: SessionDoc, op: SessionOp): SessionOp {
    const before = copyDoc(doc)
    applyOp(doc, op)
    const patch = patchBetween(before, doc)
    if (!patch) throw new Error('the edit changed nothing')
    return { op: 'restore', patch: invertPatch(patch) }
  }

  it('takes back a move, the speaker it made, and a rename', () => {
    const doc = newDoc()
    upsertSpeaker(doc, 'c0', speaker('Speaker 1'))
    replaceTranscript(doc, [line('a', 'c0', 0, 2, 'hello'), line('b', 'c0', 2, 4, 'there')])
    const original = copyDoc(doc)
    const unmove = edit(doc, { op: 'assign', ids: ['b'], speaker: 'c1', create: { name: '', personId: null, confirmed: false } })
    const unname = edit(doc, { op: 'name', id: 'c1', name: 'Ana', personId: null })
    applyOp(doc, unname)
    expect(names(doc)).toEqual({ c0: 'Speaker 1', c1: '' })
    applyOp(doc, unmove)
    expect(doc.transcript).toEqual(original.transcript)
    expect(doc.speakers).toEqual(original.speakers)
    // The removed speaker's id is still never handed out again.
    expect(newSpeakerId(doc)).toBe('c2')
  })

  it('leaves what changed since, and redoes what it undid', () => {
    const doc = newDoc()
    replaceTranscript(doc, [line('a', null, 0, 2, 'hello there')])
    const before = copyDoc(doc)
    applyOp(doc, { op: 'title', title: 'Mine' })
    applyOp(doc, { op: 'lineText', id: 'a', text: 'hello their' })
    applyOp(doc, { op: 'tag', tag: 'mine' })
    const patch = patchBetween(before, doc)
    if (!patch) throw new Error('no patch')
    // Meanwhile Lyra retitles nothing, but another window adds a tag and changes the line.
    applyOp(doc, { op: 'tag', tag: 'theirs' })
    applyOp(doc, { op: 'lineText', id: 'a', text: 'hullo their' })
    applyOp(doc, { op: 'restore', patch: invertPatch(patch) })
    expect(doc.title).toBe('Title')
    expect(doc.tags).toEqual(['theirs'])
    expect(doc.transcript[0]?.text).toBe('hullo their')
    // Notes aren't covered: their editor keeps its own history.
    expect(patchBetween(before, { ...before, notes: 'typed' })).toBeNull()
    applyOp(doc, { op: 'restore', patch })
    expect(doc.title).toBe('Mine')
    expect(doc.tags).toEqual(['theirs', 'mine'])
  })
})

describe('changedFields', () => {
  it('lists the top-level fields whose value differs', () => {
    const doc = newDoc('a')
    const next = copyDoc(doc)
    expect(changedFields(doc, next)).toEqual([])
    next.notes = 'b'
    addTag(next, 'x')
    expect(changedFields(doc, next)).toEqual(['notes', 'tags'])
  })
})

import { describe, expect, it } from 'vitest'
import { emptyDoc, replaceTranscript, type SessionDoc, type SessionOp } from '../../../shared/sessionDoc'
import { SessionReplica } from './sessionReplica'

/** A main that answers by hand: each send waits until the test settles it. */
function setup(doc: SessionDoc = emptyDoc({ title: 'T', notes: '' })) {
  const sent: { seq: number; ops: SessionOp[]; resolve: (rev: number) => void; reject: (error: Error) => void }[] = []
  let clock = 0
  const replica = new SessionReplica(
    's.txt',
    { rev: 5, doc },
    (seq, ops) =>
      new Promise<number>((resolve, reject) => {
        sent.push({ seq, ops, resolve, reject })
      }),
    () => clock
  )
  return {
    replica,
    sent,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('SessionReplica', () => {
  it('shows an edit at once and keeps it over changes from elsewhere until main has it', async () => {
    const { replica, sent } = setup()
    const done = replica.edit([{ op: 'notes', notes: 'typed' }], 'none')
    expect(replica.doc.notes).toBe('typed')
    expect(sent.map((entry) => [entry.seq, entry.ops])).toEqual([[1, [{ op: 'notes', notes: 'typed' }]]])
    // Lyra writes a summary before main gets to the edit: both show.
    expect(replica.receive({ id: 's.txt', rev: 6, changes: { summary: 'S' }, ack: null })).toBe(true)
    expect(replica.doc).toMatchObject({ notes: 'typed', summary: 'S' })
    // Main applies it: the change carries it back, confirmed.
    expect(replica.receive({ id: 's.txt', rev: 7, changes: { notes: 'typed' }, ack: 1 })).toBe(true)
    sent[0]?.resolve(7)
    await done
    expect(replica.doc).toMatchObject({ notes: 'typed', summary: 'S' })
  })

  it('ignores changes it has, and asks to reopen after one it missed', () => {
    const { replica } = setup()
    expect(replica.receive({ id: 's.txt', rev: 5, changes: { title: 'old' }, ack: null })).toBe(true)
    expect(replica.receive({ id: 'other.txt', rev: 9, changes: { title: 'other' }, ack: null })).toBe(true)
    expect(replica.doc.title).toBe('T')
    expect(replica.receive({ id: 's.txt', rev: 7, changes: { title: 'skipped' }, ack: null })).toBe(false)
    replica.reset({ rev: 7, doc: emptyDoc({ title: 'Reopened', notes: '' }) })
    expect(replica.doc.title).toBe('Reopened')
  })

  it('drops an edit main refused', async () => {
    const { replica, sent } = setup()
    const done = replica.edit([{ op: 'title', title: 'Mine' }])
    sent[0]?.reject(new Error('refused'))
    await expect(done).rejects.toThrow('refused')
    expect(replica.doc.title).toBe('T')
  })

  it('keeps fields an edit left alone as main sent them', () => {
    const doc = emptyDoc({ title: 'T', notes: '' })
    replaceTranscript(doc, [{ id: 'a', rawId: null, start: 0, end: 1, cluster: null, confidence: null, text: 'hi' }])
    const { replica } = setup(doc)
    void replica.edit([{ op: 'notes', notes: 'typed' }], 'none')
    expect(replica.doc.transcript).toBe(doc.transcript)
  })

  it('undoes quick typing in the title as one step, and redoes it', () => {
    const { replica, sent, tick } = setup()
    void replica.edit([{ op: 'title', title: 'T1' }], 'typing')
    tick(200)
    void replica.edit([{ op: 'title', title: 'T12' }], 'typing')
    tick(1000)
    void replica.edit([{ op: 'tag', tag: 'x' }])
    expect(replica.undoAt()).toBe(1200)
    void replica.undo()
    expect(replica.doc.tags).toEqual([])
    void replica.undo()
    expect(replica.doc.title).toBe('T')
    expect(replica.canUndo()).toBe(false)
    expect(sent.at(-1)?.ops).toEqual([{ op: 'restore', patch: { title: { from: 'T12', to: 'T' } } }])
    void replica.redo()
    expect(replica.doc.title).toBe('T12')
    // A new edit drops what could be redone.
    void replica.edit([{ op: 'title', title: 'New' }])
    expect(replica.canRedo()).toBe(false)
  })

  it('makes no undo step for the notes', () => {
    const { replica } = setup()
    void replica.edit([{ op: 'notes', notes: 'typed' }])
    expect(replica.canUndo()).toBe(false)
    expect(replica.undo()).toBe(false)
  })
})

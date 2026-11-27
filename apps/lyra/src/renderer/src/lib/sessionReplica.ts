import {
  applyOp,
  changedFields,
  copyDoc,
  DOC_FIELDS,
  invertPatch,
  patchBetween,
  type SessionChanges,
  type SessionDoc,
  type SessionOp,
  type SessionPatch
} from '../../../shared/sessionDoc'

/**
 * A window's copy of an open session. Main owns the document; this holds main's latest state
 * (`base`) plus this window's edits main hasn't confirmed yet, and shows both, so typing never
 * waits on a round trip. Every edit sets a value (`SessionOp`), so showing one main has already
 * applied does no harm. Pure, so its rules are unit-tested.
 *
 * Undo covers this window's edits to the title, summary, tags, speakers and transcript, not
 * the notes (their editor keeps its own history, which knows the selection). A step is undone
 * by asking main to put back what it changed, only where nothing has changed it since.
 */

/** Typing in the title or summary within this long of the last keystroke is one undo step. */
const MERGE_MS = 600

type Pending = { seq: number; ops: SessionOp[]; rev: number | null }
type Step = { patch: SessionPatch; at: number; typing: 'title' | 'summary' | null }

export type ReplicaChange = { id: string; rev: number; changes: SessionChanges; ack: number | null }

export class SessionReplica {
  private base: SessionDoc
  private rev: number
  private seq = 0
  private pending: Pending[] = []
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private shown: SessionDoc

  constructor(
    readonly id: string,
    opened: { rev: number; doc: SessionDoc },
    /** Sends edits to main; resolves to the `rev` of the change that applied them. */
    private readonly send: (seq: number, ops: SessionOp[]) => Promise<number>,
    private readonly now: () => number = Date.now
  ) {
    this.base = opened.doc
    this.rev = opened.rev
    this.shown = opened.doc
  }

  /** What the window shows: main's state with this window's unconfirmed edits on top. */
  get doc(): SessionDoc {
    return this.shown
  }

  /**
   * Takes a change from main. False when one was missed (its `rev` skips ahead): the caller
   * reopens the session and `reset`s with what main sends.
   */
  receive(change: ReplicaChange): boolean {
    if (change.id !== this.id || change.rev <= this.rev) return true
    if (change.rev !== this.rev + 1) return false
    const next = { ...this.base }
    for (const key of DOC_FIELDS) {
      if (change.changes[key] !== undefined) Object.assign(next, { [key]: change.changes[key] })
    }
    this.base = next
    this.rev = change.rev
    const ack = change.ack
    this.pending = this.pending.filter(
      (entry) => (ack === null || entry.seq > ack) && (entry.rev === null || entry.rev > this.rev)
    )
    this.refresh()
    return true
  }

  /** Main's whole state again, after a missed change. */
  reset(opened: { rev: number; doc: SessionDoc }): void {
    if (opened.rev < this.rev) return
    this.base = opened.doc
    this.rev = opened.rev
    this.pending = this.pending.filter((entry) => entry.rev === null || entry.rev > this.rev)
    this.refresh()
  }

  /**
   * Applies edits here at once and sends them to main. `undoable`: whether they make an undo
   * step (`typing` merges quick keystrokes in the title or summary into one). Resolves once
   * main has them; rejects (and drops them from what's shown) when main refused them.
   */
  edit(ops: SessionOp[], undoable: 'step' | 'typing' | 'none' = 'step'): Promise<void> {
    const before = this.shown
    const sent = this.push(ops)
    if (undoable !== 'none') {
      const patch = patchBetween(before, this.shown)
      if (patch) this.record(patch, undoable === 'typing')
    }
    return sent
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** When the top undo step was made (or undone), or null with nothing to undo. */
  undoAt(): number | null {
    return this.undoStack.at(-1)?.at ?? null
  }

  redoAt(): number | null {
    return this.redoStack.at(-1)?.at ?? null
  }

  /** Takes back this window's last step; false when there's nothing to undo. */
  undo(): Promise<void> | false {
    const step = this.undoStack.pop()
    if (!step) return false
    this.redoStack.push({ ...step, at: this.now(), typing: null })
    return this.push([{ op: 'restore', patch: invertPatch(step.patch) }])
  }

  redo(): Promise<void> | false {
    const step = this.redoStack.pop()
    if (!step) return false
    this.undoStack.push({ ...step, at: this.now(), typing: null })
    return this.push([{ op: 'restore', patch: step.patch }])
  }

  private record(patch: SessionPatch, typing: boolean): void {
    this.redoStack = []
    const at = this.now()
    const field = typing ? onlyText(patch) : null
    const last = this.undoStack.at(-1)
    if (field && last?.typing === field && at - last.at < MERGE_MS) {
      const from = last.patch[field]?.from
      const to = patch[field]?.to
      if (from !== undefined && to !== undefined) {
        last.patch = { [field]: { from, to } }
        last.at = at
        return
      }
    }
    this.undoStack.push({ patch, at, typing: field })
  }

  private push(ops: SessionOp[]): Promise<void> {
    const entry: Pending = { seq: ++this.seq, ops, rev: null }
    this.pending.push(entry)
    this.refresh()
    return this.send(entry.seq, ops).then(
      (rev) => {
        // Main has it: it stays shown until the change carrying it arrives.
        entry.rev = rev
        if (rev <= this.rev) this.drop(entry)
      },
      (error: unknown) => {
        this.drop(entry)
        throw error
      }
    )
  }

  private drop(entry: Pending): void {
    const before = this.pending.length
    this.pending = this.pending.filter((other) => other !== entry)
    if (this.pending.length !== before) this.refresh()
  }

  /** Rebuilds what's shown, keeping each field the edits didn't touch as main's own object. */
  private refresh(): void {
    if (!this.pending.length) {
      this.shown = this.base
      return
    }
    const draft = copyDoc(this.base)
    for (const { ops } of this.pending) for (const op of ops) applyOp(draft, op)
    const shown = { ...this.base }
    for (const key of changedFields(this.base, draft)) Object.assign(shown, { [key]: draft[key] })
    this.shown = shown
  }
}

/** The text field a typing step changed, when it changed only that. */
function onlyText(patch: SessionPatch): 'title' | 'summary' | null {
  const keys = Object.keys(patch)
  if (keys.length !== 1) return null
  return keys[0] === 'title' || keys[0] === 'summary' ? keys[0] : null
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageSummary, SessionChangeEvent, SessionOpened } from '../../../shared/types'
import {
  newSpeakerId,
  type SessionOp,
  type SpeakerEntry,
  type TranscriptSegment
} from '../../../shared/sessionDoc'
import type { Span, TranscriptEdit } from '../../../shared/transcriptOverlay'
import { log } from '../lib/log'
import { SessionReplica } from '../lib/sessionReplica'
import { notify } from '../lib/toast'
import { latest } from './latest'

/** What the editor shows of the open session. */
export type OpenPage = {
  id: string
  title: string
  /** The user's notes. */
  body: string
  /** Generated meeting notes, above the user's notes. */
  summary: string
  tags: string[]
  transcript: TranscriptSegment[]
  speakers: SpeakerEntry[]
}

/** A speaker made from the transcript: named by the user, or a blank one to name after a split. */
export type NewSpeaker = { name: string; personId: string | null; confirmed: boolean }

type Edit = { title?: string; body?: string }

type Open = {
  replica: SessionReplica
  /** Draws the session's current state. */
  render: () => void
  /** An edit main refused: it's gone from the view; the user is told once. */
  failed: (error: unknown) => void
  dispose: () => void
}

/**
 * The page list, plus the open session. Main owns each session; this window shows main's copy
 * with its own edits on top until main confirms them (`SessionReplica`), and changes made
 * elsewhere (meeting labeling, notes, another window) arrive as change events.
 */
export function usePages() {
  const [pages, setPages] = useState<PageSummary[]>([])
  const [current, setCurrent] = useState<OpenPage | null>(null)
  const currentRef = useRef<OpenPage | null>(null)
  const session = useRef<Open | null>(null)
  /** Edits main hasn't confirmed yet; `flush` waits for all of them. */
  const pending = useRef(new Set<Promise<void>>())
  const [opens] = useState(latest)
  /** The session the newest `attach` is opening. */
  const wanted = useRef<string | null>(null)

  const show = (page: OpenPage | null): void => {
    currentRef.current = page
    setCurrent(page)
  }

  const refreshList = useCallback(async () => {
    const list = await window.api.listPages()
    setPages(list)
    return list
  }, [])

  const flush = useCallback(async () => {
    while (pending.current.size) await Promise.all([...pending.current])
  }, [])

  const detach = useCallback(async () => {
    const open = session.current
    if (!open) return
    session.current = null
    await flush()
    open.dispose()
    window.api.closeSession(open.replica.id)
  }, [flush])

  const attach = useCallback(
    async (id: string) => {
      // Opening sessions quickly (clicks, search, a create) overlaps these awaits; only the
      // newest open may become the open session, or the view and `edit` could disagree.
      const token = opens.begin()
      wanted.current = id
      await detach()
      if (!opens.isCurrent(token)) return
      // Listening before opening, so a change between main's reply and here isn't missed.
      const early: SessionChangeEvent[] = []
      let open: Open | null = null
      const onChange = (change: SessionChangeEvent): void => {
        if (change.id !== id) return
        if (!open) {
          early.push(change)
          return
        }
        const mine = open
        if (!mine.replica.receive(change)) {
          log('pages', 'missed a session change; reopening', { rev: change.rev })
          void window.api.openSession(id).then(
            (state) => {
              mine.replica.reset(state)
              mine.render()
            },
            (error: unknown) => {
              log('pages', 'could not reopen session', String(error))
            }
          )
        }
        mine.render()
      }
      const stop = window.api.onSessionChange(onChange)
      let state: SessionOpened
      try {
        state = await window.api.openSession(id)
      } catch (error) {
        stop()
        throw error
      }
      if (!opens.isCurrent(token)) {
        stop()
        // Main keeps one subscription per window and session, so this one is only let go of when
        // the open that won isn't for the same session.
        if (wanted.current !== id && session.current?.replica.id !== id) window.api.closeSession(id)
        return
      }
      const send = (seq: number, ops: SessionOp[]): Promise<number> => {
        const sent = window.api.editSession(id, seq, ops)
        // `flush` waits on these and must not throw; the edit's caller handles the failure.
        const settled = sent.then(
          () => undefined,
          () => undefined
        )
        pending.current.add(settled)
        void settled.finally(() => {
          pending.current.delete(settled)
        })
        return sent
      }
      const replica = new SessionReplica(id, state, send)
      let warnedUnsaved = false
      const opened: Open = {
        replica,
        render: () => {
          // A replaced session's late changes must never draw over the one now open.
          if (session.current !== opened) return
          const doc = replica.doc
          show({
            id,
            title: doc.title,
            body: doc.notes,
            summary: doc.summary,
            tags: doc.tags,
            transcript: doc.transcript,
            speakers: doc.speakers
          })
        },
        failed: (error) => {
          log('pages', 'could not save change', String(error))
          opened.render()
          if (warnedUnsaved) return
          warnedUnsaved = true
          notify('Lyra couldn’t save your latest changes to this session. Copy anything important, then reopen it.')
        },
        dispose: stop
      }
      open = opened
      session.current = opened
      for (const change of early) onChange(change)
      opened.render()
    },
    [opens, detach]
  )

  /** Applies an edit to the open session and sends it to main. */
  const apply = useCallback((ops: SessionOp[], undoable: 'step' | 'typing' | 'none') => {
    const open = session.current
    if (!open) return
    open.replica.edit(ops, undoable).catch(open.failed)
    open.render()
  }, [])

  const edit = useCallback(
    (changes: Edit) => {
      const ops: SessionOp[] = []
      if (changes.title !== undefined) ops.push({ op: 'title', title: changes.title })
      if (changes.body !== undefined) ops.push({ op: 'notes', notes: changes.body })
      // The notes editor keeps its own undo; typing in the title is one step per pause.
      if (ops.length) apply(ops, changes.title !== undefined ? 'typing' : 'none')
    },
    [apply]
  )

  const editSummary = useCallback(
    (summary: string) => {
      apply([{ op: 'summary', summary }], 'typing')
    },
    [apply]
  )
  /** A transcript action (correct, remove, highlight, rewrite, reassign) is one undo step. */
  const editSegment = useCallback(
    (id: string, text: string) => {
      apply([{ op: 'lineText', id, text }], 'step')
    },
    [apply]
  )
  /** Sets a line's corrections, removals and highlights over its raw words. */
  const editLineOverlay = useCallback(
    (id: string, edits: readonly TranscriptEdit[]) => {
      apply([{ op: 'lineEdits', id, edits: edits.map((one) => ({ ...one })) }], 'step')
    },
    [apply]
  )
  /** Moves lines to a speaker, creating it first when given a name. Returns the speaker's id. */
  const assignLines = useCallback(
    (ids: readonly string[], speaker: string | NewSpeaker): string | null => {
      const open = session.current
      if (!open) return null
      const id = typeof speaker === 'string' ? speaker : newSpeakerId(open.replica.doc)
      const create = typeof speaker === 'string' ? {} : { create: speaker }
      apply([{ op: 'assign', ids: [...ids], speaker: id, ...create }], 'step')
      return id
    },
    [apply]
  )
  /**
   * Gives some of a line's words (a range of its original) to a speaker, creating it first when
   * given a name; the line splits around them. Returns the speaker's id.
   */
  const splitLine = useCallback(
    (id: string, span: Span, speaker: string | NewSpeaker): string | null => {
      const open = session.current
      if (!open) return null
      const to = typeof speaker === 'string' ? speaker : newSpeakerId(open.replica.doc)
      const create = typeof speaker === 'string' ? {} : { create: speaker }
      apply([{ op: 'splitLine', id, start: span.start, end: span.end, speaker: to, ...create }], 'step')
      return to
    },
    [apply]
  )
  /** Names a speaker (merging into one with the same name or person), as one undo step. */
  const nameSpeaker = useCallback(
    (id: string, name: string, personId: string | null) => {
      apply([{ op: 'name', id, name, personId }], 'step')
    },
    [apply]
  )
  const tag = useCallback(
    (name: string) => {
      apply([{ op: 'tag', tag: name }], 'step')
    },
    [apply]
  )
  const untag = useCallback(
    (name: string) => {
      apply([{ op: 'untag', tag: name }], 'step')
    },
    [apply]
  )

  const history = useCallback((again: boolean): boolean => {
    const open = session.current
    if (!open) return false
    const done = again ? open.replica.redo() : open.replica.undo()
    if (done === false) return false
    done.catch(open.failed)
    open.render()
    return true
  }, [])
  const undo = useCallback(() => history(false), [history])
  const redo = useCallback(() => history(true), [history])
  const undoAt = useCallback(() => session.current?.replica.undoAt() ?? null, [])
  const redoAt = useCallback(() => session.current?.replica.redoAt() ?? null, [])

  const open = useCallback((id: string) => attach(id), [attach])

  const close = useCallback(async () => {
    opens.cancel()
    wanted.current = null
    await detach()
    show(null)
  }, [opens, detach])

  const create = useCallback(
    async (options?: { startedAt?: string }) => {
      await flush()
      const page = await window.api.createPage(options)
      await attach(page.id)
      await refreshList()
      return page
    },
    [flush, attach, refreshList]
  )

  const remove = useCallback(
    async (id: string) => {
      const wasOpen = session.current?.replica.id === id
      if (wasOpen) await detach()
      await window.api.deletePage(id)
      const list = await refreshList()
      if (!wasOpen && currentRef.current?.id !== id) return
      const next = list[0]
      if (next) await attach(next.id)
      else show(null)
    },
    [detach, attach, refreshList]
  )

  /** Undoes `remove`: brings the session back and opens it. */
  const restore = useCallback(
    async (id: string) => {
      await window.api.restorePage(id)
      await refreshList()
      await attach(id)
    },
    [attach, refreshList]
  )

  useEffect(() => {
    void refreshList().then(async (list) => {
      const first = list[0]
      if (first && !session.current) await attach(first.id)
    })
    return () => {
      opens.cancel()
      void detach()
    }
  }, [opens, refreshList, attach, detach])

  // Notes added or removed outside Lyra, or a title or preview changed: refresh the list. The
  // open session's content itself arrives as change events.
  useEffect(
    () =>
      window.api.onPagesChanged(() => {
        void refreshList().then(async (list) => {
          const openId = session.current?.replica.id
          if (!openId || list.some((page) => page.id === openId)) return
          // The open note's file was removed outside Lyra.
          await detach()
          const next = list[0]
          if (next) await attach(next.id)
          else show(null)
        })
      }),
    [refreshList, attach, detach]
  )

  return {
    pages,
    current,
    currentRef,
    edit,
    editSummary,
    editSegment,
    editLineOverlay,
    assignLines,
    splitLine,
    nameSpeaker,
    tag,
    untag,
    undo,
    redo,
    undoAt,
    redoAt,
    open,
    close,
    create,
    remove,
    restore,
    flush
  }
}

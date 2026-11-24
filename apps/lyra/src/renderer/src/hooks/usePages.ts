import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { PageSummary } from '../../../shared/types'
import {
  addTag,
  docSummary,
  docTitle,
  docTranscript,
  docMeta,
  editDoc,
  newSpeakerId,
  ORIGIN_REMOTE,
  ORIGIN_USER,
  mergeSpeakers,
  removeTag,
  speakerToMergeInto,
  setSegmentEdits,
  setSegmentsCluster,
  setSegmentText,
  snapshotOf,
  transcriberCursor,
  liveModeOf,
  type LiveMode,
  upsertSpeaker,
  type SpeakerEntry,
  type TranscriptSegment
} from '../../../shared/sessionDoc'
import type { TranscriptEdit } from '../../../shared/transcriptOverlay'
import { log } from '../lib/log'

export type SaveState = 'saved' | 'saving'

/** What the editor shows of the open session. */
export type OpenPage = {
  id: string
  title: string
  /** The user's notes. */
  body: string
  /** Generated meeting notes, above the user's notes. */
  summary: string
  tags: string[]
  /** Where live transcription lands in `body`, or null before the first recording. */
  transcriberAt: number | null
  /** Where the recording's words are going: the notes, or the speaker-labeled transcript. */
  liveMode: LiveMode | null
  transcript: TranscriptSegment[]
  speakers: SpeakerEntry[]
}

/** A speaker made from the transcript: named by the user, or a blank one to name after a split. */
export type NewSpeaker = { name: string; personId: string | null; confirmed: boolean }


type Edit = { title?: string; body?: string }

const STAMP = 'at'

/** When the top step of an undo or redo stack was made, or null when it's empty. */
function stampOf(stack: readonly { meta: Map<unknown, unknown> }[]): number | null {
  const at = stack.at(-1)?.meta.get(STAMP)
  return typeof at === 'number' ? at : null
}

type Replica = {
  id: string
  doc: Y.Doc
  undo: Y.UndoManager
  dispose: () => void
}

/**
 * The page list, plus the open session as a Yjs replica of main's document. Edits go to the
 * replica and stream to main as updates; changes made elsewhere (meeting labeling, notes,
 * another window) arrive the same way and merge instead of overwriting.
 */
export function usePages() {
  const [pages, setPages] = useState<PageSummary[]>([])
  const [current, setCurrent] = useState<OpenPage | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const currentRef = useRef<OpenPage | null>(null)
  const replica = useRef<Replica | null>(null)
  /** Updates main hasn't confirmed yet; `flush` waits for all of them. */
  const pending = useRef(new Set<Promise<void>>())

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
    const open = replica.current
    if (!open) return
    replica.current = null
    await flush()
    open.dispose()
    window.api.closeSession(open.id)
  }, [flush])

  const attach = useCallback(
    async (id: string) => {
      await detach()
      const state = await window.api.openSession(id)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state, ORIGIN_REMOTE)
      const title = docTitle(doc)
      const render = (): void => {
        const snapshot = snapshotOf(doc)
        show({
          id,
          title: snapshot.title,
          body: snapshot.notes,
          summary: snapshot.summary,
          tags: snapshot.tags,
          transcriberAt: transcriberCursor(doc),
          liveMode: liveModeOf(doc),
          transcript: snapshot.transcript,
          speakers: snapshot.speakers
        })
      }

      const onUpdate = (update: Uint8Array, origin: unknown): void => {
        render()
        if (origin === ORIGIN_REMOTE) return
        setSaveState('saving')
        const sent = window.api.updateSession(id, update).catch((error: unknown) => {
          log('pages', 'could not save change', String(error))
        })
        pending.current.add(sent)
        void sent.finally(() => {
          pending.current.delete(sent)
          if (!pending.current.size) setSaveState('saved')
        })
      }
      doc.on('update', onUpdate)
      const stopRemote = window.api.onSessionUpdate((change) => {
        if (change.id === id) Y.applyUpdate(doc, change.update, ORIGIN_REMOTE)
      })
      // Undo covers this window's own edits only, never text that arrived from elsewhere. The
      // notes editor keeps its own history (it knows the user's selection), so they're not here.
      const undo = new Y.UndoManager([title, docSummary(doc), docTranscript(doc), docMeta(doc)], {
        trackedOrigins: new Set([ORIGIN_USER]),
        captureTimeout: 600
      })
      // Stamp each step with when it was done or undone, so App's Ctrl+Z can order document
      // edits against actions outside the document (see lib/history).
      const stamp = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }): void => {
        stackItem.meta.set(STAMP, Date.now())
      }
      undo.on('stack-item-added', stamp)
      undo.on('stack-item-updated', stamp)

      replica.current = {
        id,
        doc,
        undo,
        dispose: () => {
          stopRemote()
          undo.destroy()
          doc.off('update', onUpdate)
          doc.destroy()
        }
      }
      render()
    },
    [detach]
  )

  const edit = useCallback((changes: Edit) => {
    const open = replica.current
    if (!open) return
    editDoc(open.doc, { title: changes.title, notes: changes.body }, ORIGIN_USER)
  }, [])

  /** Runs a change on the open document as the user's own (undoable) edit. */
  const change = useCallback((apply: (doc: Y.Doc) => void) => {
    const open = replica.current
    if (open) apply(open.doc)
  }, [])

  const editSummary = useCallback(
    (summary: string) => change((doc) => editDoc(doc, { summary }, ORIGIN_USER)),
    [change]
  )
  /**
   * A transcript action (correct, remove, highlight, rewrite, reassign) as one undo step of its
   * own: typing merges keystrokes into a step, but two quick menu actions must undo separately.
   */
  const step = useCallback((apply: (doc: Y.Doc) => void) => {
    const open = replica.current
    if (!open) return
    open.undo.stopCapturing()
    apply(open.doc)
    open.undo.stopCapturing()
  }, [])

  const editSegment = useCallback(
    (id: string, text: string) => step((doc) => setSegmentText(doc, id, text, ORIGIN_USER)),
    [step]
  )
  /** Sets a line's corrections, removals and highlights over its raw words. */
  const editLineOverlay = useCallback(
    (id: string, edits: readonly TranscriptEdit[]) =>
      step((doc) => setSegmentEdits(doc, id, edits, ORIGIN_USER)),
    [step]
  )
  /** Moves lines to a speaker, creating it first when given a name. Returns the speaker's id. */
  const assignLines = useCallback(
    (ids: readonly string[], speaker: string | NewSpeaker): string | null => {
      const open = replica.current
      if (!open) return null
      const id = typeof speaker === 'string' ? speaker : newSpeakerId(open.doc)
      open.undo.stopCapturing()
      open.doc.transact(() => {
        if (typeof speaker !== 'string') {
          upsertSpeaker(open.doc, id, {
            name: speaker.name,
            personId: speaker.personId,
            confirmed: speaker.confirmed,
            confidence: null,
            matches: []
          }, ORIGIN_USER)
        }
        setSegmentsCluster(open.doc, ids, id, ORIGIN_USER)
      }, ORIGIN_USER)
      open.undo.stopCapturing()
      return id
    },
    []
  )
  /** Names a speaker (merging into one with the same name or person), as one undo step. */
  const nameSpeaker = useCallback(
    (id: string, name: string, personId: string | null) =>
      step((doc) => {
        doc.transact(() => {
          const into = speakerToMergeInto(doc, id, name, personId)
          upsertSpeaker(doc, into ?? id, { name, personId, confirmed: true }, ORIGIN_USER)
          if (into) mergeSpeakers(doc, id, into, ORIGIN_USER)
        }, ORIGIN_USER)
      }),
    [step]
  )
  const tag = useCallback(
    (name: string) => change((doc) => addTag(doc, name, ORIGIN_USER)),
    [change]
  )
  const untag = useCallback(
    (name: string) => change((doc) => removeTag(doc, name, ORIGIN_USER)),
    [change]
  )

  const undo = useCallback(() => !!replica.current?.undo.undo(), [])
  const redo = useCallback(() => !!replica.current?.undo.redo(), [])
  const undoAt = useCallback(() => stampOf(replica.current?.undo.undoStack ?? []), [])
  const redoAt = useCallback(() => stampOf(replica.current?.undo.redoStack ?? []), [])

  const open = useCallback((id: string) => attach(id), [attach])

  const close = useCallback(async () => {
    await detach()
    show(null)
  }, [detach])

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
      const wasOpen = replica.current?.id === id
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
      if (first && !replica.current) await attach(first.id)
    })
    return () => {
      void detach()
    }
  }, [refreshList, attach, detach])

  // Notes added or removed outside Lyra, or a title or preview changed: refresh the list. The
  // open session's content itself syncs through its document.
  useEffect(
    () =>
      window.api.onPagesChanged(() => {
        void refreshList().then(async (list) => {
          const openId = replica.current?.id
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
    saveState,
    edit,
    editSummary,
    editSegment,
    editLineOverlay,
    assignLines,
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

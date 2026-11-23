import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { PageSummary } from '../../../shared/types'
import {
  docNotes,
  docTitle,
  editDoc,
  ORIGIN_REMOTE,
  ORIGIN_USER
} from '../../../shared/sessionDoc'
import { log } from '../lib/log'

export type SaveState = 'saved' | 'saving'

/** What the editor shows of the open session. */
export type OpenPage = {
  id: string
  title: string
  body: string
}

type Edit = { title?: string; body?: string }

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
      const notes = docNotes(doc)
      const render = (): void => {
        show({ id, title: title.toJSON(), body: notes.toJSON() })
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
      // Undo covers this window's own edits only, never text that arrived from elsewhere.
      const undo = new Y.UndoManager([title, notes], {
        trackedOrigins: new Set([ORIGIN_USER]),
        captureTimeout: 600
      })

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

  const undo = useCallback(() => replica.current?.undo.undo() !== null, [])
  const redo = useCallback(() => replica.current?.undo.redo() !== null, [])

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
    undo,
    redo,
    open,
    close,
    create,
    remove,
    flush
  }
}

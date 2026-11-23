'use client'

import { cx } from '@/lib/cx'
import { exportText, metaJson, metaName, sessionsTree } from '@/lib/demo/export'
import type { FileSelection, Session } from '@/lib/demo/types'
import { useDemo } from './DemoProvider'
import { FileIcon, FolderIcon, JsonIcon } from '@/components/site/SiteIcons'
import styles from './showcase.module.css'

const ENCODER = new TextEncoder()

/** The notes folder as Lyra leaves it: an export and its metadata per session, plus .sessions/. */
export function FilesBrowser() {
  const { state, exportContext, dispatch } = useDemo()
  const sessions = [...state.sessions].sort((a, b) => b.startedAt - a.startedAt)
  const [newest] = sessions
  let selected: FileSelection = state.selectedFile
  let session: Session | undefined
  if (selected.kind !== 'sessions') {
    const id = selected.id
    session = sessions.find((s) => s.id === id)
    if (!session && newest) {
      session = newest
      selected = { kind: 'export', id: newest.id }
    }
  }

  const name = selected.kind === 'sessions' ? '.sessions/' : session ? (selected.kind === 'export' ? session.id : metaName(session)) : ''
  const text =
    selected.kind === 'sessions'
      ? sessionsTree(state.sessions, state.settings)
      : session
        ? selected.kind === 'export'
          ? exportText(session, exportContext)
          : metaJson(session, exportContext)
        : ''
  const isSelected = (kind: FileSelection['kind'], id?: string): boolean =>
    selected.kind === kind && (selected.kind === 'sessions' || selected.id === id)
  const pick = (selection: FileSelection): void => {
    dispatch({ type: 'selectFile', selection })
  }

  return (
    <div className={cx(styles.card, styles.finder)}>
      <div className={styles.flSide}>
        <div className={styles.flPath}>
          <FolderIcon />
          ~/.lyra
        </div>
        <ul className={styles.flList}>
          <li>
            <button
              type="button"
              className={cx(styles.fl, styles.hiddenDir, isSelected('sessions') && styles.flActive)}
              aria-pressed={isSelected('sessions')}
              onClick={() => pick({ kind: 'sessions' })}
            >
              <FolderIcon />
              <span className={styles.flName}>.sessions/</span>
              <span className={styles.flTitle}>Audio, raw transcripts, edit history</span>
            </button>
          </li>
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={cx(styles.fl, isSelected('export', s.id) && styles.flActive)}
                aria-pressed={isSelected('export', s.id)}
                onClick={() => pick({ kind: 'export', id: s.id })}
              >
                <FileIcon />
                <span className={styles.flName}>{s.id}</span>
                <span className={styles.flTitle}>
                  {s.title || 'Untitled'}
                  {s.fromDemo ? <span className={styles.chip}>From the demo</span> : null}
                </span>
              </button>
              <button
                type="button"
                className={cx(styles.fl, styles.flMeta, isSelected('meta', s.id) && styles.flActive)}
                aria-pressed={isSelected('meta', s.id)}
                onClick={() => pick({ kind: 'meta', id: s.id })}
              >
                <JsonIcon />
                <span className={styles.flName}>{metaName(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.fv}>
        <div className={styles.fvHead}>
          <b>{name}</b>
          <span>
            {selected.kind === 'sessions'
              ? 'Hidden in Finder and Explorer'
              : `${ENCODER.encode(text).length.toLocaleString('en-US')} bytes · UTF-8`}
          </span>
        </div>
        <pre className={styles.fvText} tabIndex={0} aria-label="File contents">
          {text}
        </pre>
      </div>
    </div>
  )
}

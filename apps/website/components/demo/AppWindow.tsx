'use client'

// The app's main window (apps/lyra/src/renderer/src/App.tsx), driven by the demo store and a
// scripted voice instead of window.api and the microphone.
import { useCallback, useEffect, useRef, useState } from 'react'
import { linesOf, sessionWords, summaryOf, toMarkdown } from '@/lib/demo/export'
import { tagCounts } from '@/lib/demo/preview'
import { stateOf } from '@/lib/demo/speakers'
import { readingMinutes } from '@/lib/demo/text'
import { clock, relativeTime } from '@/lib/demo/time'
import { shortcutLabel, useMediaQuery, useOs } from '@/lib/platform'
import { ScrollArea } from './Controls'
import { useDemo } from './DemoProvider'
import { DetailsPanel } from './DetailsPanel'
import { DictationDock, useElapsed, Waveform } from './DictationDock'
import { Editor } from './Editor'
import { CheckIcon, CopyIcon, PanelIcon } from './Icons'
import { SettingsSheet } from './SettingsSheet'
import { Sidebar } from './Sidebar'
import { TagRow } from './TagRow'
import { Transcript } from './Transcript'
import { useScriptedDictation } from './useScriptedDictation'

const UNDO_MS = 6000
const NOTES_MS = 1400

type CopyState = 'idle' | 'copied' | 'failed'

export function AppWindow() {
  const { state, current, exportContext, dispatch } = useDemo()
  const os = useOs()
  const wide = useMediaQuery('(min-width: 1020px)')
  const panel = state.panel && wide
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hint, setHint] = useState(true)
  const [copied, setCopied] = useState<CopyState>('idle')
  const [saving, setSaving] = useState(false)
  const [playingLine, setPlayingLine] = useState<string | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [onScreen, setOnScreen] = useState(true)
  const windowEl = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLElement>(null)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep new words in view, unless the visitor scrolled up or is typing.
  const follow = useCallback(() => {
    const view = scroller.current
    if (!view) return
    const typing = document.activeElement instanceof HTMLTextAreaElement && view.contains(document.activeElement)
    if (typing || view.scrollHeight - view.scrollTop - view.clientHeight > 200) return
    requestAnimationFrame(() => {
      view.scrollTo({ top: view.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  const dictation = useScriptedDictation({
    onBegin: () => {
      dispatch({ type: 'beginTranscription' })
    },
    onCommit: (chunk) => {
      dispatch({ type: 'transcribe', chunk })
      follow()
    },
    onEnd: (seconds) => {
      dispatch({ type: 'endTranscription', seconds })
    }
  })
  const { phase, start, stop } = dictation
  const recording = phase === 'starting' || phase === 'listening'

  const toggle = useCallback(() => {
    setHint(false)
    if (recording) stop()
    else start(current.body.trim() !== '')
  }, [recording, stop, start, current.body])

  /** A new session, named for this moment, recording straight away (the + button and hotkey). */
  const startSession = useCallback(() => {
    setHint(false)
    stop()
    dispatch({ type: 'create' })
    start(false)
  }, [stop, start, dispatch])

  const open = (id: string): void => {
    stop()
    setPlayingLine(null)
    setNaming(null)
    dispatch({ type: 'open', id })
  }
  const remove = (id: string): void => {
    if (id === current.id) stop()
    dispatch({ type: 'remove', id })
  }
  const togglePanel = useCallback(() => {
    dispatch({ type: 'panel', open: !state.panel })
  }, [dispatch, state.panel])

  const copy = (): void => {
    navigator.clipboard.writeText(toMarkdown(current, exportContext)).then(
      () => {
        setCopied('copied')
      },
      () => {
        setCopied('failed')
      }
    )
  }
  const reveal = (): void => {
    dispatch({ type: 'selectFile', selection: { kind: 'export', id: current.id } })
    document.getElementById('files')?.scrollIntoView({ behavior: 'smooth' })
  }
  const writeNotes = useCallback(() => {
    dispatch({ type: 'notesBusy', busy: true })
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(() => {
      dispatch({ type: 'notesBusy', busy: false })
    }, NOTES_MS)
  }, [dispatch])
  const chooseSpeaker = (id: string): void => {
    const speaker = state.speakers.find((s) => s.id === id)
    if (!speaker || id === 'c1') return
    if (stateOf(speaker) === 'likely') dispatch({ type: 'confirmSpeaker', id })
    else setNaming(id)
  }
  const listen = (id: string): void => {
    setPlayingLine((playing) => (playing === id ? null : id))
  }

  // A line plays for as long as it was spoken.
  useEffect(() => {
    if (!playingLine) return
    const line = state.lines.find((l) => l.id === playingLine)
    const timer = setTimeout(() => {
      setPlayingLine(null)
    }, line ? (line.end - line.start) * 1000 : 0)
    return () => {
      clearTimeout(timer)
    }
  }, [playingLine, state.lines])

  useEffect(() => {
    if (copied === 'idle') return
    const timer = setTimeout(() => {
      setCopied('idle')
    }, 1500)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])

  // "Saving…" for a moment after each change, like the app's autosave.
  const lastEdit = useRef(current.editedAt)
  useEffect(() => {
    if (lastEdit.current === current.editedAt) return
    lastEdit.current = current.editedAt
    setSaving(true)
    const timer = setTimeout(() => {
      setSaving(false)
    }, 400)
    return () => {
      clearTimeout(timer)
    }
  }, [current.editedAt])

  // Deleting can be undone for a few seconds, instead of a confirm dialog.
  useEffect(() => {
    if (!state.trashed) return
    const timer = setTimeout(() => {
      dispatch({ type: 'forgetRemoved' })
    }, UNDO_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [state.trashed, dispatch])

  useEffect(
    () => () => {
      if (notesTimer.current) clearTimeout(notesTimer.current)
    },
    []
  )

  // The floating pill takes over when the window scrolls out of view.
  useEffect(() => {
    const el = windowEl.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        setOnScreen(entry?.isIntersecting ?? true)
      },
      { threshold: 0.25 }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  // The app's shortcuts, on the whole page.
  const keys = useRef({ startSession, toggle, togglePanel, wide })
  useEffect(() => {
    keys.current = { startSession, toggle, togglePanel, wide }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const { startSession: newSession, toggle: dictate, togglePanel: details, wide: roomy } = keys.current
      if (event.shiftKey && event.code === 'Space') {
        event.preventDefault()
        newSession()
        windowEl.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else if (event.shiftKey && event.code === 'KeyD') {
        event.preventDefault()
        dictate()
      } else if (!event.shiftKey && event.key === '.' && roomy) {
        event.preventDefault()
        details()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const known = tagCounts(state.sessions)
  const words = sessionWords(current, exportContext)
  const lines = linesOf(current, exportContext)
  const notesOn = state.settings.notesEngine !== 'off'
  const listening = phase === 'listening'
  const elapsed = useElapsed(dictation.startedAt)

  return (
    <div ref={windowEl} className="lyra-ui demo-window">
      <div className="app">
        <Sidebar
          tags={known}
          onCreate={startSession}
          onOpen={open}
          onDelete={remove}
          onSettings={() => setSettingsOpen(true)}
          newSessionTitle={`New session (${shortcutLabel(os, 'N')})`}
        />

        <div className={panel ? 'workspace with-panel' : 'workspace'}>
          <header className="topbar">
            <span className={`save-state${saving ? ' is-saving' : ''}`} aria-live="polite">
              {saving ? 'Saving…' : 'Saved'}
            </span>
            <button className="btn" type="button" onClick={copy} title="Copy as Markdown">
              {copied === 'copied' ? <CheckIcon /> : <CopyIcon />}
              {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy'}
            </button>
            <button
              className="icon-btn panel-toggle"
              type="button"
              aria-pressed={panel}
              aria-label="Details panel"
              title={`Details panel (${shortcutLabel(os, '.')})`}
              onClick={togglePanel}
            >
              <PanelIcon />
            </button>
          </header>

          <div className="workspace-body">
            <div className="workspace-column">
              <ScrollArea className="scroller" ref={scroller}>
                <article className="page">
                  <input
                    className="title-input"
                    value={current.title}
                    onChange={(event) => dispatch({ type: 'editTitle', title: event.target.value })}
                    placeholder="Untitled"
                    aria-label="Session title"
                  />
                  {panel ? null : (
                    <>
                      <p className="page-stats">
                        <span>
                          {words} {words === 1 ? 'word' : 'words'}
                        </span>
                        {words > 0 ? <span>{readingMinutes(words)} min read</span> : null}
                        <span>Edited {relativeTime(current.editedAt, state.now).toLowerCase()}</span>
                      </p>
                      <TagRow
                        tags={current.tags}
                        known={known}
                        onAdd={(tag) => dispatch({ type: 'tag', tag })}
                        onRemove={(tag) => dispatch({ type: 'untag', tag })}
                      />
                    </>
                  )}
                  {current.meeting ? (
                    <section className="summary" aria-label="Meeting notes">
                      <h2 className="section-label">Meeting notes</h2>
                      <Editor
                        value={summaryOf(current, exportContext)}
                        ghost=""
                        listening={false}
                        label="Meeting notes"
                        onChange={(summary) => dispatch({ type: 'editSummary', summary })}
                      />
                    </section>
                  ) : null}
                  <Editor
                    value={current.body}
                    ghost={dictation.ghost}
                    listening={listening}
                    transcriberAt={state.transcriberAt}
                    onChange={(body) => dispatch({ type: 'editBody', body })}
                  />
                  {lines.length ? (
                    <Transcript
                      lines={lines}
                      speakers={state.speakers}
                      playback={null}
                      playingLine={playingLine}
                      onListen={listen}
                      onConfirm={(id) => dispatch({ type: 'confirmSpeaker', id })}
                      onName={(id, name) => dispatch({ type: 'nameSpeaker', id, name })}
                      onEditLine={(id, text) => dispatch({ type: 'editLine', id, text })}
                      onRestoreLine={(id) => dispatch({ type: 'restoreLine', id })}
                      notes={notesOn ? { busy: state.notesBusy, onWrite: writeNotes } : null}
                      naming={naming}
                      onNamingChange={setNaming}
                    />
                  ) : null}
                </article>
              </ScrollArea>

              <DictationDock
                phase={phase}
                startedAt={dictation.startedAt}
                subscribeLevel={dictation.subscribeLevel}
                onToggle={toggle}
                systemAudio={state.settings.systemAudio}
                onSystemAudioChange={(systemAudio) => dispatch({ type: 'settings', patch: { systemAudio } })}
                compact={panel}
                shortcut={shortcutLabel(os, 'D', true)}
                hint={hint}
              >
                {listening && state.settings.systemAudio && !state.settings.noticeSeen ? (
                  <div className="banner" role="status">
                    <span className="banner-dot" aria-hidden="true" />
                    Recording the computer’s audio too. Make sure everyone on the call is OK with it.
                    <button
                      className="btn"
                      type="button"
                      onClick={() => dispatch({ type: 'settings', patch: { noticeSeen: true } })}
                    >
                      Got it
                    </button>
                  </div>
                ) : null}
                {state.trashed ? (
                  <div className="toast" role="status">
                    <span>Deleted session “{state.trashed.session.title || 'Untitled'}”</span>
                    <button type="button" onClick={() => dispatch({ type: 'undoRemove' })}>
                      Undo
                    </button>
                  </div>
                ) : null}
              </DictationDock>
            </div>

            {panel ? (
              <DetailsPanel
                knownTags={known}
                onSpeaker={chooseSpeaker}
                onCopy={copy}
                onReveal={reveal}
                onWriteNotes={notesOn ? writeNotes : null}
              />
            ) : null}
          </div>
        </div>
      </div>

      {settingsOpen ? (
        <SettingsSheet
          onClose={() => setSettingsOpen(false)}
          newSessionShortcut={shortcutLabel(os, 'Space', true)}
        />
      ) : null}

      {listening && !onScreen ? (
        <div className="demo-pill" role="status">
          <span className="demo-pill-dot" aria-hidden="true" />
          <span>Recording</span>
          <span className="dock-timer">{clock(elapsed / 1000)}</span>
          <Waveform subscribe={dictation.subscribeLevel} bars={12} />
          <button className="btn" type="button" onClick={stop}>
            Stop
          </button>
        </div>
      ) : null}
    </div>
  )
}

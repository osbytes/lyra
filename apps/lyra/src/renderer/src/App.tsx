import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PageSummary, UpdateStatus, WhisperStatus } from '../../shared/types'
import { DetailsPanel } from './components/DetailsPanel'
import { DictationDock } from './components/DictationDock'
import { Editor } from './components/Editor'
import { TagRow } from './components/TagRow'
import { Transcript } from './components/Transcript'
import { CheckIcon, CopyIcon, FolderIcon, MicIcon, PanelIcon } from './components/Icons'
import { SettingsDialog } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { useDictation } from './hooks/useDictation'
import { usePages, type OpenPage } from './hooks/usePages'
import { useSettings } from './hooks/useSettings'
import { homePath, readingMinutes, relativeTime, shortcutLabel, wordCount } from './lib/format'
import { promptFor } from './text/transcript'

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80

/** How long a deleted page can be brought back before its file is removed. */
const UNDO_DELETE_MS = 6000

/** The title field and the editor: where undo/redo means "undo my edit to this page". */
function isPageField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.classList.contains('title-input') ||
      target.classList.contains('editor') ||
      target.classList.contains('line-text'))
  )
}

function toMarkdown(page: OpenPage): string {
  const names = new Map(page.speakers.map((speaker) => [speaker.id, speaker.name]))
  const lines = page.transcript.map((line) => {
    const name = line.cluster ? (names.get(line.cluster) ?? 'Speaker') : 'Speaker'
    return `**${name}:** ${line.text}`
  })
  const body = [page.summary.trim(), page.body.trim(), lines.join('\n\n')]
    .filter(Boolean)
    .join('\n\n')
  return page.title && page.title !== 'Untitled' ? `# ${page.title}\n\n${body}` : body
}

export default function App(): React.JSX.Element {
  const {
    pages,
    current,
    currentRef,
    saveState,
    edit,
    editSummary,
    editSegment,
    assignLines,
    appendDictation,
    beginTranscription,
    tag,
    untag,
    undo,
    redo,
    open,
    close,
    create,
    remove,
    flush
  } = usePages()
  const [status, setStatus] = useState<WhisperStatus>({ state: 'idle' })
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [copied, setCopied] = useState(false)
  const { settings, update: updateSettings } = useSettings()
  const [showSettings, setShowSettings] = useState(false)
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const titleInput = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stopStatus = window.api.onStatus(setStatus)
    const stopUpdate = window.api.onUpdateStatus(setUpdate)
    return () => {
      stopStatus()
      stopUpdate()
    }
  }, [])

  const onCommit = useCallback(
    (text: string) => {
      if (!currentRef.current) return
      const view = scroller.current
      // Keep new words in view, unless the writer has scrolled up to reread, or is typing:
      // then their place on the page matters more than the transcriber's.
      const typing = document.activeElement instanceof HTMLTextAreaElement
      const follow =
        !typing && (!view || view.scrollHeight - view.scrollTop - view.clientHeight < 160)
      appendDictation(text)
      if (follow) {
        requestAnimationFrame(() => view?.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }))
      }
    },
    [currentRef, appendDictation]
  )

  // Whisper's prompt is the text just before where its words will land.
  const getContext = useCallback(() => {
    const page = currentRef.current
    if (!page) return ''
    return promptFor(page.title, page.body.slice(0, page.transcriberAt ?? page.body.length))
  }, [currentRef])

  const getDeviceId = useCallback(() => settingsRef.current?.micDeviceId ?? null, [])

  const dictation = useDictation({ getContext, onCommit, getDeviceId })
  const { recording, stop: stopDictation, start } = dictation

  /** Stops recording and writes the page to disk right away, so the file is complete. */
  const stop = useCallback(async () => {
    await stopDictation()
    await flush()
  }, [stopDictation, flush])

  /** Records into a session: the mic, plus the computer's audio when that setting is on. */
  const record = useCallback(
    async (pageId: string) => {
      beginTranscription()
      await start({ pageId, systemAudio: settingsRef.current?.captureSystemAudio ?? true })
    },
    [start, beginTranscription]
  )

  /** A new session, named for this moment, recording straight away. */
  const startSession = useCallback(async () => {
    await stop()
    const page = await create({ startedAt: new Date().toISOString() })
    await record(page.id)
  }, [stop, create, record])

  // Commands from the tray, the global hotkey, and the overlay pill.
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  useEffect(
    () =>
      window.api.onSessionCommand((command) => {
        if (command.type === 'stop' || recordingRef.current) void stop()
        else void startSession()
      }),
    [stop, startSession]
  )

  // Mirror recorder state to main for the tray and the overlay pill.
  const { phase, live, micName, subscribeLevel } = dictation
  const listeningSince = useRef<number | null>(null)
  useEffect(() => {
    if (phase === 'listening') listeningSince.current ??= Date.now()
    if (phase === 'idle') listeningSince.current = null
    window.api.reportSession({
      phase,
      startedAt: listeningSince.current,
      micName
    })
  }, [phase, micName])

  const liveRef = useRef(live)
  liveRef.current = live
  useEffect(() => {
    let last = 0
    return subscribeLevel((level) => {
      const now = performance.now()
      if (now - last < OVERLAY_FRAME_MS) return
      last = now
      window.api.reportOverlayFrame({ level, live: liveRef.current })
    })
  }, [subscribeLevel])

  /** The dock: continue recording the open session, or stop. */
  const toggleDictation = useCallback(() => {
    if (recording) void stop()
    else if (currentRef.current) void record(currentRef.current.id)
  }, [recording, stop, record, currentRef])

  const openPage = async (id: string): Promise<void> => {
    await stop()
    await open(id)
  }

  // Deleting hides the page at once and removes its file after a few seconds, so the user can
  // undo instead of answering a confirm dialog. If Lyra quits first, the note simply survives.
  const [trashed, setTrashed] = useState<PageSummary | null>(null)
  const trashTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  const commitTrash = useCallback(async () => {
    const pending = trashTimer.current
    if (!pending) return
    clearTimeout(pending.timer)
    trashTimer.current = null
    setTrashed(null)
    await remove(pending.id)
  }, [remove])

  const deletePage = async (page: PageSummary): Promise<void> => {
    await commitTrash()
    if (page.id === current?.id) {
      await stop()
      const next = pages.find((other) => other.id !== page.id)
      if (next) await open(next.id)
      else await close()
    }
    const timer = setTimeout(() => void commitTrash(), UNDO_DELETE_MS)
    trashTimer.current = { id: page.id, timer }
    setTrashed(page)
  }

  const undoDelete = (): void => {
    const pending = trashTimer.current
    if (!pending) return
    clearTimeout(pending.timer)
    trashTimer.current = null
    setTrashed(null)
    void open(pending.id)
  }

  const undoToast = trashed ? (
    <div className="toast" role="status">
      <span>Deleted session “{trashed.title || 'Untitled'}”</span>
      <button type="button" onClick={undoDelete}>
        Undo
      </button>
    </div>
  ) : null

  const copy = (): void => {
    if (!current) return
    window.api.copyText(toMarkdown(current))
    setCopied(true)
  }

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const panel = settings?.detailsPanel ?? false
  const toggleLayout = useCallback(() => {
    void updateSettings({ detailsPanel: !(settingsRef.current?.detailsPanel ?? false) })
  }, [updateSettings])

  // Tags across every session, most used first, for the sidebar filter and the tag picker.
  const knownTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const page of pages) for (const tag of page.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [pages])
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  useEffect(() => {
    if (tagFilter && !knownTags.some(([tag]) => tag === tagFilter)) setTagFilter(null)
  }, [knownTags, tagFilter])
  const [pickerRequest, setPickerRequest] = useState<{ speaker: string; anchor: DOMRect } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      // The page's text lives in a shared document, so undo goes through it (and skips text
      // that arrived from elsewhere) instead of the textarea's own history.
      if ((key === 'z' || key === 'y') && isPageField(event.target)) {
        event.preventDefault()
        if (key === 'y' || event.shiftKey) redo()
        else undo()
        return
      }
      if (key === 'd' && event.shiftKey) {
        event.preventDefault()
        toggleDictation()
      } else if (key === 'n') {
        event.preventDefault()
        void startSession()
      } else if (key === '.') {
        event.preventDefault()
        toggleLayout()
      } else if (key === ',') {
        event.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDictation, startSession, toggleLayout, undo, redo])

  const words = current
    ? wordCount([current.summary, current.body, ...current.transcript.map((line) => line.text)].join(' '))
    : 0
  const summary = current ? pages.find((page) => page.id === current.id) : undefined
  const editedAt = summary?.updatedAt
  const systemAudio = settings?.captureSystemAudio ?? true

  return (
    <div className={`app platform-${window.api.platform}`}>
      <Sidebar
        pages={trashed ? pages.filter((page) => page.id !== trashed.id) : pages}
        activeId={current?.id}
        update={update}
        onOpen={(id) => void openPage(id)}
        onCreate={() => void startSession()}
        onDelete={(page) => void deletePage(page)}
        onSettings={() => setShowSettings(true)}
        tags={knownTags}
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
      />

      <main className={panel ? 'workspace with-panel' : 'workspace'}>
        <header className="topbar drag">
          {current ? (
            <>
              <span className={`save-state${saveState === 'saving' ? ' is-saving' : ''}`}>
                {saveState === 'saving' ? 'Saving…' : 'Saved'}
              </span>
              <button
                className="btn no-drag"
                type="button"
                onClick={copy}
                disabled={!current.body && !current.summary && !current.transcript.length}
                title="Copy as Markdown"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                className="icon-btn no-drag panel-toggle"
                type="button"
                aria-pressed={panel}
                aria-label="Details panel"
                title={`Details panel (${shortcutLabel('.')})`}
                onClick={toggleLayout}
              >
                <PanelIcon />
              </button>
            </>
          ) : null}
        </header>

        {status.state === 'downloading' && status.total ? (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${(status.received / status.total) * 100}%` }} />
          </div>
        ) : null}

        {current ? (
          <div className="workspace-body">
          <div className="workspace-column">
            <div className="scroller" ref={scroller}>
              <article className="page">
                <input
                  ref={titleInput}
                  className="title-input"
                  value={current.title}
                  onChange={(event) => edit({ title: event.target.value })}
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
                      {editedAt ? <span>Edited {relativeTime(editedAt).toLowerCase()}</span> : null}
                    </p>
                    <TagRow tags={current.tags} known={knownTags} onAdd={tag} onRemove={untag} />
                  </>
                )}
                {current.summary.trim() ? (
                  <section className="summary" aria-label="Meeting notes">
                    <h2 className="section-label">Meeting notes</h2>
                    <Editor
                      value={current.summary}
                      ghost=""
                      listening={false}
                      label="Meeting notes"
                      onChange={editSummary}
                    />
                  </section>
                ) : null}
                <Editor
                  value={current.body}
                  ghost={dictation.live}
                  listening={dictation.phase === 'listening'}
                  transcriberAt={current.transcriberAt}
                  onChange={(body) => edit({ body })}
                />
                {current.transcript.length ? (
                  <Transcript
                    pageId={current.id}
                    transcript={current.transcript}
                    speakers={current.speakers}
                    hasSummary={!!current.summary.trim()}
                    notesEngine={settings?.notesEngine ?? 'off'}
                    onEditLine={editSegment}
                    onAssign={assignLines}
                    onUndo={() => void undo()}
                    showSpeakersBar={!panel}
                    pickerRequest={pickerRequest}
                  />
                ) : null}
              </article>
            </div>
            <DictationDock
              phase={dictation.phase}
              micName={dictation.micName}
              status={status}
              error={dictation.error}
              notice={dictation.notice}
              micDeviceId={settings?.micDeviceId ?? null}
              onMicChange={(micDeviceId) => void updateSettings({ micDeviceId })}
              systemAudio={systemAudio}
              onSystemAudioChange={(captureSystemAudio) => void updateSettings({ captureSystemAudio })}
              compact={panel}
              subscribeLevel={dictation.subscribeLevel}
              onToggle={toggleDictation}
            >
              {dictation.recording && systemAudio && settings && !settings.meetingNoticeSeen ? (
                <div className="banner" role="status">
                  <span className="banner-dot" aria-hidden="true" />
                  Recording the computer’s audio too. Make sure everyone on the call is OK with it.
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void updateSettings({ meetingNoticeSeen: true })}
                  >
                    Got it
                  </button>
                </div>
              ) : null}
              {undoToast}
            </DictationDock>
          </div>
          {panel ? (
            <DetailsPanel
              page={current}
              summary={summary}
              words={words}
              knownTags={knownTags}
              notesEngine={settings?.notesEngine ?? 'off'}
              onAddTag={tag}
              onRemoveTag={untag}
              onSpeaker={(speaker, target) => {
                setPickerRequest({ speaker, anchor: target.getBoundingClientRect() })
              }}
              onCopy={copy}
            />
          ) : null}
          </div>
        ) : (
          <div className="empty">
            <div className="empty-inner">
              <span className="empty-icon" aria-hidden="true">
                <MicIcon />
              </span>
              <h2>Start your first session</h2>
              <p>
                Start a session and talk, alone or on a call. Lyra transcribes on this computer,
                names speakers when there’s more than one, and saves a plain text file you own.
              </p>
              <button className="btn primary" type="button" onClick={() => void startSession()}>
                <MicIcon />
                Start session
                <kbd>{shortcutLabel('N')}</kbd>
              </button>
              {settings ? (
                <span className="empty-folder" title={settings.notesDir}>
                  <FolderIcon />
                  Saved to <code>{homePath(settings.notesDir)}</code>
                </span>
              ) : null}
            </div>
            {undoToast ? <div className="dock-area">{undoToast}</div> : null}
          </div>
        )}
      </main>

      {showSettings && settings ? (
        <SettingsDialog settings={settings} update={updateSettings} onClose={closeSettings} />
      ) : null}
    </div>
  )
}

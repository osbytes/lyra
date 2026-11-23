import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PageSummary, UpdateStatus, WhisperStatus } from '../../shared/types'
import type { TranscriptSegment } from '../../shared/sessionDoc'
import { DetailsPanel } from './components/DetailsPanel'
import { DictationDock } from './components/DictationDock'
import { Editor } from './components/Editor'
import { NotesEditor, type NotesHandle } from './components/NotesEditor'
import { TagRow } from './components/TagRow'
import { ScrollArea } from './components/Controls'
import { Transcript } from './components/Transcript'
import { CheckIcon, CopyIcon, FolderIcon, GearIcon, MicIcon, PanelIcon, PlusIcon } from './components/Icons'
import { SettingsDialog } from './components/Settings'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { useDictation } from './hooks/useDictation'
import { usePages, type OpenPage } from './hooks/usePages'
import { useSettings } from './hooks/useSettings'
import { clockLabel, homePath, readingMinutes, relativeTime, shortcutLabel, wordCount } from './lib/format'
import { promptFor } from './text/transcript'

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80

/** How long a deleted page can be brought back before its file is removed. */
const UNDO_DELETE_MS = 6000

/** Smallest share of the column either pane can be dragged down to. */
const MIN_PANE = 0.15

/**
 * The title, meeting notes and the transcript: where undo/redo means "undo my edit to this
 * page". The notes editor isn't here; it keeps its own history.
 */
function isPageField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  // Nothing focused (a menu just closed): undo means the page, as in any editor.
  if (target === document.body) return true
  if (target.classList.contains('title-input') || target.classList.contains('editor')) return true
  // Anywhere in the locked transcript, except a field with its own text history.
  return (
    !!target.closest('.transcript') &&
    !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  )
}

/** A quote of the transcript for the notes: the words, then who said them and when. */
function quoteOf(text: string, who: string | null, start: number): string {
  const said = text.replace(/\s+/g, ' ').trim()
  const by = who ? `${who}, ${clockLabel(start)}` : clockLabel(start)
  return `> ${said}\n>\n> — *${by}*`
}

/** How long to wait for an opened session's transcript to render before giving up. */
const REVEAL_FRAMES = 60

/** Scrolls a transcript line into view and flashes it, once the opened session renders it. */
function revealLine(lineId: string, frame = 0): void {
  const text = document.querySelector(`[data-line="${CSS.escape(lineId)}"]`)
  const line = text?.closest('.line')
  if (!line) {
    if (frame < REVEAL_FRAMES) requestAnimationFrame(() => revealLine(lineId, frame + 1))
    return
  }
  line.scrollIntoView({ block: 'center', behavior: 'smooth' })
  line.classList.add('search-flash')
  line.addEventListener('animationend', () => line.classList.remove('search-flash'), { once: true })
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
  /** This recording's committed phrases, in the order they were sent to main. */
  const [sent, setSent] = useState<string[]>([])
  const {
    pages,
    current,
    currentRef,
    saveState,
    edit,
    editSummary,
    editSegment,
    editLineOverlay,
    assignLines,
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
  const [showSearch, setShowSearch] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const titleInput = useRef<HTMLInputElement>(null)
  /** The transcript pane, which follows new words while recording. */
  const scroller = useRef<HTMLElement>(null)
  const notes = useRef<NotesHandle>(null)
  const column = useRef<HTMLDivElement>(null)
  /** The notes pane's share of the column, above the transcript. */
  const [split, setSplit] = useState(0.45)

  useEffect(() => {
    const stopStatus = window.api.onStatus(setStatus)
    const stopUpdate = window.api.onUpdateStatus(setUpdate)
    return () => {
      stopStatus()
      stopUpdate()
    }
  }, [])

  const onCommit = useCallback(
    (text: string, at: { start: number; end: number }) => {
      if (!currentRef.current) return
      const view = scroller.current
      // Keep new words in view, unless the user has scrolled the transcript up to reread. The
      // notes scroll on their own, so typing there never fights the transcript.
      const follow = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 160
      // Main voiceprints the phrase and writes it to its speaker's line; until then it's drawn
      // as unconfirmed text, so words never blink out.
      setSent((list) => [...list, text])
      window.api.appendRecordingText(text, at.start, at.end)
      if (follow) {
        requestAnimationFrame(() => view?.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }))
      }
    },
    [currentRef]
  )

  // Whisper's prompt is the text just before where its words will land.
  const getContext = useCallback(() => {
    const page = currentRef.current
    if (!page) return ''
    if (page.liveMode === 'transcript') {
      return promptFor(page.title, page.transcript.map((line) => line.text).join(' '))
    }
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
      setSent([])
      await start({ pageId, systemAudio: settingsRef.current?.captureSystemAudio ?? true })
    },
    [start]
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
      } else if (key === 'k' && !event.shiftKey) {
        event.preventDefault()
        setShowSearch((open) => !open)
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
  const toTranscript = current?.liveMode === 'transcript'
  const listening = dictation.phase === 'listening'
  const unplaced = sent.slice(current?.livePlaced ?? 0).join(' ')
  const liveText = toTranscript && listening ? `${unplaced}${dictation.live}`.trim() : null
  const hasTranscript = !!current && (current.transcript.length > 0 || liveText !== null)

  const quote = (line: TranscriptSegment, text: string): void => {
    const page = currentRef.current
    if (!page) return
    const who = line.cluster ? (page.speakers.find((s) => s.id === line.cluster)?.name ?? null) : null
    notes.current?.append(quoteOf(text, who, line.start))
  }

  /** Dragging the divider between the notes and the transcript. */
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = column.current?.getBoundingClientRect()
    if (!box) return
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      const share = (next.clientY - box.top) / box.height
      setSplit(Math.min(1 - MIN_PANE, Math.max(MIN_PANE, share)))
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

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
        onSearch={() => setShowSearch(true)}
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
            <div className="panes" ref={column}>
            <ScrollArea
              className={hasTranscript ? 'scroller notes-pane' : 'scroller notes-pane is-alone'}
              style={hasTranscript ? { flexBasis: `${String(split * 100)}%` } : undefined}
            >
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
                <NotesEditor
                  key={current.id}
                  ref={notes}
                  value={current.body}
                  onChange={(body) => edit({ body })}
                  placeholder={
                    hasTranscript
                      ? 'Write your notes here. The transcript stays below, as it was heard.'
                      : 'Start a recording, or just type. Your notes save automatically.'
                  }
                />
              </article>
            </ScrollArea>
            {hasTranscript ? (
              <>
                <div
                  className="pane-divider"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize notes and transcript"
                  aria-valuenow={Math.round(split * 100)}
                  aria-valuemin={Math.round(MIN_PANE * 100)}
                  aria-valuemax={Math.round((1 - MIN_PANE) * 100)}
                  tabIndex={0}
                  onPointerDown={resize}
                  onDoubleClick={() => setSplit(0.45)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                    event.preventDefault()
                    const step = event.key === 'ArrowUp' ? -0.05 : 0.05
                    setSplit((value) => Math.min(1 - MIN_PANE, Math.max(MIN_PANE, value + step)))
                  }}
                />
                <ScrollArea className="scroller transcript-pane" ref={scroller}>
                  <div className="page transcript-page">
                    <Transcript
                      pageId={current.id}
                      transcript={current.transcript}
                      speakers={current.speakers}
                      hasSummary={!!current.summary.trim()}
                      notesEngine={settings?.notesEngine ?? 'off'}
                      onEditLine={editSegment}
                      onEditOverlay={editLineOverlay}
                      onQuote={quote}
                      onAssign={assignLines}
                      onUndo={() => void undo()}
                      showSpeakersBar={!panel}
                      pickerRequest={pickerRequest}
                      live={liveText}
                    />
                  </div>
                </ScrollArea>
              </>
            ) : null}
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

      {showSearch ? (
        <CommandPalette
          pages={trashed ? pages.filter((page) => page.id !== trashed.id) : pages}
          activeId={current?.id}
          onOpen={(id, line) => void openPage(id).then(() => line && revealLine(line))}
          onClose={() => setShowSearch(false)}
          commands={[
            {
              id: 'new',
              label: 'New session',
              keywords: 'create record start',
              shortcut: shortcutLabel('N'),
              icon: <PlusIcon />,
              run: () => void startSession()
            },
            ...(current
              ? [
                  {
                    id: 'dictate',
                    label: recording ? 'Stop recording' : 'Continue recording',
                    keywords: 'dictate microphone record',
                    shortcut: shortcutLabel('D', true),
                    icon: <MicIcon />,
                    run: toggleDictation
                  },
                  {
                    id: 'copy',
                    label: 'Copy as Markdown',
                    keywords: 'clipboard export',
                    icon: <CopyIcon />,
                    run: copy
                  },
                  {
                    id: 'panel',
                    label: panel ? 'Hide details panel' : 'Show details panel',
                    keywords: 'layout sidebar',
                    shortcut: shortcutLabel('.'),
                    icon: <PanelIcon />,
                    run: toggleLayout
                  }
                ]
              : []),
            {
              id: 'settings',
              label: 'Settings',
              keywords: 'preferences options',
              shortcut: shortcutLabel(','),
              icon: <GearIcon />,
              run: () => setShowSettings(true)
            }
          ]}
        />
      ) : null}

      {showSettings && settings ? (
        <SettingsDialog settings={settings} update={updateSettings} onClose={closeSettings} />
      ) : null}
    </div>
  )
}

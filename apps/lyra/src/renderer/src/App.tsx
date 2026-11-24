import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PageSummary, UpdateStatus, WhisperStatus } from '../../shared/types'
import type { TranscriptSegment } from '../../shared/sessionDoc'
import { DetailsPanel } from './components/DetailsPanel'
import { DictationDock } from './components/DictationDock'
import { Summary } from './components/Summary'
import { NotesEditor, type NotesHandle } from './components/NotesEditor'
import { TagRow } from './components/TagRow'
import { ScrollArea } from './components/Controls'
import { Transcript } from './components/Transcript'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FolderIcon,
  GearIcon,
  MicIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon
} from './components/Icons'
import { SettingsDialog } from './components/Settings'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FindBar } from './components/FindBar'
import { TooltipLayer } from './components/Tooltip'
import { useDictation } from './hooks/useDictation'
import { usePages, type OpenPage } from './hooks/usePages'
import { useSettings } from './hooks/useSettings'
import { useSettingsIssues } from './hooks/useSettingsIssues'
import { clockLabel, homePath, readingMinutes, relativeTime, shortcutLabel, wordCount } from './lib/format'
import {
  onHistory,
  perform,
  redo as redoAction,
  redoAt as historyRedoAt,
  undo as undoAction,
  undoAt as historyUndoAt
} from './lib/history'
import { notify, onToast, type ToastMessage } from './lib/toast'
import { tip } from './components/Tooltip'

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80
/** Within this many pixels of the bottom, the transcript follows new lines. */
const FOLLOW_SLACK = 160

/** How long a toast stays up. */
const TOAST_MS = 6000

/** Smallest share of the column either pane can be dragged down to. */
const MIN_PANE = 0.15
/** The notes pane's share of the column when the split is reset. */
const DEFAULT_SPLIT = 0.45

/**
 * How the session column shares its height: both panes, the notes alone (the transcript
 * collapsed to its bar), or the transcript alone (its bar at the top).
 */
type PaneMode = 'split' | 'notes' | 'transcript'

/** The transcript bar's up/down buttons step through the modes in screen order. */
const PANE_UP: Record<PaneMode, PaneMode | null> = { notes: 'split', split: 'transcript', transcript: null }
const PANE_DOWN: Record<PaneMode, PaneMode | null> = { transcript: 'split', split: 'notes', notes: null }

/**
 * The title, meeting notes and the transcript: where undo/redo means "undo my edit to this
 * page". The notes editor isn't here; it keeps its own history.
 */
function isPageField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('title-input') || target.classList.contains('editor')) return true
  // Anywhere in the locked transcript, except a field with its own text history.
  return (
    !!target.closest('.transcript') &&
    !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  )
}

function isInButton(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button') !== null
}

/** A field with its own text history (search, rename, settings): undo stays native there. */
function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button'].includes(target.type)
  return target instanceof HTMLElement && target.isContentEditable
}

/** A quote of the transcript for the notes: the words, then who said them and when. */
function quoteOf(text: string, who: string | null, start: number): string {
  const said = text.replace(/\s+/g, ' ').trim()
  const by = who ? `${who}, ${clockLabel(start)}` : clockLabel(start)
  return `> ${said}\n>\n> *${by}*`
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
    nameSpeaker,
    tag,
    untag,
    undo,
    redo,
    undoAt,
    redoAt,
    open,
    create,
    remove,
    restore,
    flush
  } = usePages()
  const [status, setStatus] = useState<WhisperStatus>({ state: 'idle' })
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [copied, setCopied] = useState(false)
  const { settings, update: updateSettings } = useSettings()
  const settingsIssues = useSettingsIssues(settings)
  const [showSettings, setShowSettings] = useState(false)
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const [showSearch, setShowSearch] = useState(false)
  /** Find in the open session; `request` changes each time Ctrl/Cmd+F is pressed. */
  const [find, setFind] = useState<{ initial: string; request: number } | null>(null)
  const closeFind = useCallback(() => setFind(null), [])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  /** The transcript pane, which follows new words while recording. */
  const scroller = useRef<HTMLElement>(null)
  const notes = useRef<NotesHandle>(null)
  const column = useRef<HTMLDivElement>(null)
  /** The notes pane's share of the column, above the transcript. */
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [paneMode, setPaneMode] = useState<PaneMode>('split')

  useEffect(() => {
    const stopStatus = window.api.onStatus(setStatus)
    const stopUpdate = window.api.onUpdateStatus(setUpdate)
    return () => {
      stopStatus()
      stopUpdate()
    }
  }, [])

  const getDeviceId = useCallback(() => settingsRef.current?.micDeviceId ?? null, [])

  const dictation = useDictation({ getDeviceId })
  const { recording, stop: stopDictation, start } = dictation
  /** The session being recorded, which stays recording while other sessions are open. */
  const recordingId = dictation.pageId

  /** Stops recording and writes the page to disk right away, so the file is complete. */
  const stop = useCallback(async () => {
    await stopDictation()
    await flush()
  }, [stopDictation, flush])

  /** Records into a session: the mic, plus the computer's audio when that setting is on. */
  const record = useCallback(
    async (pageId: string) => {
      await start({ pageId, systemAudio: settingsRef.current?.captureSystemAudio ?? true })
    },
    [start]
  )

  /** A new session, named for this moment, recording straight away. */
  const startSession = useCallback(async () => {
    await stop()
    // A new recording shows its transcript arriving, whatever the last session's layout was.
    setPaneMode('split')
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
  const { phase, progress, micName, subscribeLevel } = dictation
  const [listeningSince, setListeningSince] = useState<number | null>(null)
  const sinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (phase === 'listening') sinceRef.current ??= Date.now()
    if (phase === 'idle') sinceRef.current = null
    setListeningSince(sinceRef.current)
    window.api.reportSession({
      phase,
      startedAt: sinceRef.current,
      micName
    })
  }, [phase, micName])

  const transcribing = (progress?.queued ?? 0) > 0
  const statusRef = useRef('')
  statusRef.current = transcribing ? 'Transcribing…' : ''
  useEffect(() => {
    let last = 0
    return subscribeLevel((levels) => {
      const now = performance.now()
      if (now - last < OVERLAY_FRAME_MS) return
      last = now
      window.api.reportOverlayFrame({ level: Math.max(levels.mic, levels.system ?? 0), status: statusRef.current })
    })
  }, [subscribeLevel])

  // New lines land as each chunk is transcribed; keep them in view unless the user has scrolled
  // up to reread. The notes scroll on their own, so typing there never fights the transcript.
  const lineCount = current?.transcript.length ?? 0
  const followHere = phase !== 'idle' && !!current && current.id === recordingId
  useEffect(() => {
    const view = scroller.current
    if (!view || !followHere || lineCount === 0) return
    if (view.scrollHeight - view.scrollTop - view.clientHeight > FOLLOW_SLACK) return
    requestAnimationFrame(() => view.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }))
  }, [lineCount, followHere])

  /** The dock: continue recording the open session, or stop the recording (wherever it is). */
  const toggleDictation = useCallback(() => {
    if (recording) void stop()
    else if (currentRef.current) void record(currentRef.current.id)
  }, [recording, stop, record, currentRef])

  // Opening another session leaves a recording running: its lines keep landing in its own
  // document, and the dock and sidebar show where it is.
  const openPage = async (id: string): Promise<void> => {
    setFind(null)
    await open(id)
  }

  const [toast, setToast] = useState<ToastMessage | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => onToast(setToast), [])

  // Every undoable action outside a session's document says what it did, with Undo or Redo.
  useEffect(
    () =>
      onHistory((event) => {
        if (event.quiet && event.kind === 'done') return
        setToast(
          event.kind === 'undone'
            ? { text: event.undoneLabel, action: { label: 'Redo', run: () => void redoAction() } }
            : { text: event.label, action: { label: 'Undo', run: () => void undoAction() } }
        )
      }),
    []
  )

  /** Undo or redo whichever came last: an edit to the open session, or an action elsewhere. */
  const undoLatest = useCallback(
    (again: boolean): void => {
      const doc = again ? redoAt() : undoAt()
      const action = again ? historyRedoAt() : historyUndoAt()
      if (action !== null && (doc === null || action > doc)) {
        void (again ? redoAction() : undoAction())
      } else if (again) redo()
      else undo()
    },
    [undo, redo, undoAt, redoAt]
  )

  // Deleting asks first, then can still be undone (Ctrl+Z, or the toast) until Lyra quits.
  const [confirmDelete, setConfirmDelete] = useState<PageSummary | null>(null)
  const cancelDelete = useCallback(() => setConfirmDelete(null), [])
  const deletePage = async (page: PageSummary): Promise<void> => {
    setConfirmDelete(null)
    await perform({
      label: `Deleted “${page.title || 'Untitled'}”`,
      undoneLabel: `Restored “${page.title || 'Untitled'}”`,
      run: async () => {
        if (recordingId === page.id) await stop()
        await remove(page.id)
      },
      undo: () => restore(page.id)
    })
  }

  const toastElement = toast ? (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.run()
            setToast(null)
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  ) : null

  const copy = (): void => {
    if (!current) return
    window.api.copyText(toMarkdown(current))
    setCopied(true)
    notify('Copied as Markdown')
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
      if (key === 'z' || key === 'y') {
        const again = key === 'y' || event.shiftKey
        if (isPageField(event.target)) {
          event.preventDefault()
          if (again) redo()
          else undo()
        } else if (!isTextField(event.target)) {
          event.preventDefault()
          undoLatest(again)
        }
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
      } else if (key === 'f' && !event.shiftKey && currentRef.current) {
        event.preventDefault()
        const selected = window.getSelection()?.toString().trim() ?? ''
        setFind((open) => ({
          initial: selected && !selected.includes('\n') ? selected : (open?.initial ?? ''),
          request: (open?.request ?? 0) + 1
        }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDictation, startSession, toggleLayout, undo, redo, undoLatest, currentRef])

  const words = current
    ? wordCount([current.summary, current.body, ...current.transcript.map((line) => line.text)].join(' '))
    : 0
  const summary = current ? pages.find((page) => page.id === current.id) : undefined
  const editedAt = summary?.updatedAt
  const systemAudio = settings?.captureSystemAudio ?? true
  const listening = dictation.phase === 'listening'
  const recordingHere = !!current && current.id === recordingId && (listening || dictation.phase === 'finishing')
  const recordingPage = recordingId ? pages.find((page) => page.id === recordingId) : undefined
  const elsewhere =
    recordingId && current && recordingId !== current.id
      ? {
          // An empty title reads as Untitled, like everywhere else.
          title: recordingPage?.title ? recordingPage.title : 'Untitled',
          onShow: () => void openPage(recordingId)
        }
      : null
  const pending = recordingHere ? { working: transcribing, finishing: dictation.phase === 'finishing' } : null
  const hasTranscript = !!current && (current.transcript.length > 0 || pending !== null)

  const quote = (line: TranscriptSegment, text: string): void => {
    const page = currentRef.current
    if (!page) return
    const who = line.cluster ? (page.speakers.find((s) => s.id === line.cluster)?.name ?? null) : null
    notes.current?.append(quoteOf(text, who, line.start))
  }

  const resetSplit = (): void => {
    setPaneMode('split')
    setSplit(DEFAULT_SPLIT)
  }

  /** Dragging the transcript's bar, which is the divider between the notes and the transcript. */
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || isInButton(event.target)) return
    const box = column.current?.getBoundingClientRect()
    if (!box) return
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    // A drag from a collapsed or expanded layout opens the split where the pointer is.
    const move = (next: PointerEvent): void => {
      const share = (next.clientY - box.top) / box.height
      setPaneMode('split')
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
        pages={pages}
        activeId={current?.id}
        recordingId={recordingId}
        update={update}
        onOpen={(id) => void openPage(id)}
        onCreate={() => void startSession()}
        onDelete={setConfirmDelete}
        onSettings={() => setShowSettings(true)}
        settingsIssue={settingsIssues.length > 0}
        onSearch={() => setShowSearch(true)}
        tags={knownTags}
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
      />

      <main className={current && panel ? 'workspace with-panel' : 'workspace'}>
        {/* The panel runs the full height beside this column, so its header shares the top band. */}
        <div className="workspace-main">
        <header className="topbar drag">
          {current ? (
            <>
              {/* In the band beside the actions; a long title wraps onto more lines. */}
              <textarea
                className="title-input no-drag"
                rows={1}
                value={current.title}
                onChange={(event) => edit({ title: event.target.value.replace(/\s*\n\s*/g, ' ') })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  notes.current?.focus()
                }}
                placeholder="Untitled"
                aria-label="Session title"
                spellCheck={false}
              />
              <div className="topbar-actions">
              <span className={`save-state${saveState === 'saving' ? ' is-saving' : ''}`}>
                {saveState === 'saving' ? 'Saving…' : 'Saved'}
              </span>
              <button
                className="btn no-drag"
                type="button"
                onClick={copy}
                disabled={!current.body && !current.summary && !current.transcript.length}
                {...tip('Copy as Markdown')}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                className="icon-btn no-drag panel-toggle"
                type="button"
                aria-pressed={panel}
                aria-label="Details panel"
                {...tip(panel ? 'Hide details' : 'Show details', shortcutLabel('.'))}
                onClick={toggleLayout}
              >
                <PanelIcon />
              </button>
              </div>
            </>
          ) : null}
        </header>

        {status.state === 'downloading' && status.total ? (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${(status.received / status.total) * 100}%` }} />
          </div>
        ) : null}

        {current ? (
          <div
            className={
              hasTranscript && paneMode === 'notes' ? 'workspace-column transcript-collapsed' : 'workspace-column'
            }
          >
            <div className="panes" ref={column}>
            <ScrollArea
              className={
                !hasTranscript || paneMode === 'notes'
                  ? 'scroller notes-pane is-alone'
                  : paneMode === 'transcript'
                    ? 'scroller notes-pane is-collapsed'
                    : 'scroller notes-pane'
              }
              style={hasTranscript && paneMode === 'split' ? { flexBasis: `${String(split * 100)}%` } : undefined}
            >
              <article className="page">
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
                  <Summary key={`summary-${current.id}`} value={current.summary} onChange={editSummary} />
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
                  className="transcript-bar"
                  onPointerDown={resize}
                  onDoubleClick={(event) => {
                    if (!isInButton(event.target)) resetSplit()
                  }}
                >
                  <div
                    className="transcript-grip"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize notes and transcript"
                    aria-valuenow={Math.round((paneMode === 'split' ? split : paneMode === 'notes' ? 1 : 0) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    tabIndex={0}
                    {...tip('Drag to resize · double-click to reset')}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      const step = event.key === 'ArrowUp' ? -0.05 : 0.05
                      setPaneMode('split')
                      setSplit((value) => Math.min(1 - MIN_PANE, Math.max(MIN_PANE, value + step)))
                    }}
                  />
                  <h2 className="transcript-bar-title">Transcript</h2>
                  {recordingHere ? (
                    <span className="transcript-live">Live</span>
                  ) : (
                    <span className="transcript-bar-count">
                      {current.transcript.length} {current.transcript.length === 1 ? 'line' : 'lines'}
                    </span>
                  )}
                  <span className="transcript-bar-tools">
                    {PANE_UP[paneMode] ? (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={paneMode === 'notes' ? 'Show transcript' : 'Expand transcript'}
                        {...tip(paneMode === 'notes' ? 'Show transcript' : 'Expand transcript')}
                        onClick={() => setPaneMode((mode) => PANE_UP[mode] ?? mode)}
                      >
                        <ChevronUpIcon />
                      </button>
                    ) : null}
                    {PANE_DOWN[paneMode] ? (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={paneMode === 'transcript' ? 'Show notes' : 'Collapse transcript'}
                        {...tip(paneMode === 'transcript' ? 'Show notes' : 'Collapse transcript')}
                        onClick={() => setPaneMode((mode) => PANE_DOWN[mode] ?? mode)}
                      >
                        <ChevronDownIcon />
                      </button>
                    ) : null}
                  </span>
                </div>
                <ScrollArea
                  className={paneMode === 'notes' ? 'scroller transcript-pane is-collapsed' : 'scroller transcript-pane'}
                  ref={scroller}
                >
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
                      onName={nameSpeaker}
                      onUndo={() => void undo()}
                      showSpeakersBar={!panel}
                      pickerRequest={pickerRequest}
                      transcribing={pending}
                    />
                  </div>
                </ScrollArea>
              </>
            ) : null}
            </div>
            {find ? (
              <FindBar root={column} initial={find.initial} request={find.request} onClose={closeFind} />
            ) : null}
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
              transcribing={transcribing}
              onToggle={toggleDictation}
              startedAt={listeningSince}
              elsewhere={elsewhere}
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
              {toastElement}
            </DictationDock>
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
                <span className="empty-folder" {...tip(settings.notesDir)}>
                  <FolderIcon />
                  Saved to <code>{homePath(settings.notesDir)}</code>
                </span>
              ) : null}
            </div>
            {toastElement ? <div className="dock-area">{toastElement}</div> : null}
          </div>
        )}
        </div>
        {current && panel ? (
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
      </main>

      {showSearch ? (
        <CommandPalette
          pages={pages}
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
                  ...(elsewhere
                    ? [
                        {
                          id: 'recording',
                          label: `Go to “${elsewhere.title}” (recording)`,
                          keywords: 'recording live current',
                          icon: <MicIcon />,
                          run: elsewhere.onShow
                        }
                      ]
                    : []),
                  {
                    id: 'find',
                    label: 'Find in session',
                    keywords: 'search find text',
                    shortcut: shortcutLabel('F'),
                    icon: <SearchIcon />,
                    run: () => setFind((open) => ({ initial: open?.initial ?? '', request: (open?.request ?? 0) + 1 }))
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

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete “${confirmDelete.title || 'Untitled'}”?`}
          confirm="Delete session"
          danger
          onConfirm={() => void deletePage(confirmDelete)}
          onCancel={cancelDelete}
        >
          Its notes, transcript and audio are removed. You can undo this with{' '}
          <kbd>{shortcutLabel('Z')}</kbd> until Lyra quits; after that it’s in the system trash.
        </ConfirmDialog>
      ) : null}

      <TooltipLayer />

      {showSettings && settings ? (
        <SettingsDialog
          settings={settings}
          update={updateSettings}
          issues={settingsIssues}
          onClose={closeSettings}
        />
      ) : null}
    </div>
  )
}

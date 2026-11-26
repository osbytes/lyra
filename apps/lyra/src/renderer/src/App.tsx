import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PANEL_WIDTHS } from '../../shared/settings'
import { summarySections } from '../../shared/summarySections'
import type { PageSummary, WhisperStatus } from '../../shared/types'
import type { TranscriptSegment } from '../../shared/sessionDoc'
import { DetailsPanel } from './components/DetailsPanel'
import { DictationDock, DictationMessage } from './components/DictationDock'
import { ActivityToast, ProcessingToast, Toast, ToastStack } from './components/ToastStack'
import { Summary } from './components/Summary'
import { NotesEditor, type NotesHandle } from './components/NotesEditor'
import { TagRow } from './components/TagRow'
import { ScrollArea } from './components/Controls'
import { Transcript } from './components/Transcript'
import { SectionsMenu, SectionsRail, useSectionsNav } from './components/TranscriptSections'
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
  SearchIcon,
  SidebarIcon
} from './components/Icons'
import { SettingsDialog } from './components/Settings'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FindBar } from './components/FindBar'
import { PanelResizer, type PanelLayout } from './components/PanelResizer'
import { TooltipLayer } from './components/Tooltip'
import { useActivity } from './hooks/useActivity'
import { useActivityEndings } from './hooks/useActivityEndings'
import { useDictation, type StartResult } from './hooks/useDictation'
import { sessionCommandAction } from './hooks/sessionCommands'
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
import { scrollBehavior } from './lib/motion'
import { behindLabel, dockActivity } from './lib/status'
import { notify, onToast, replacesToast, type ToastMessage } from './lib/toast'
import { tip } from './components/Tooltip'
import { ActivityButton } from './components/Activity'
import lyraIcon from './assets/lyra-icon.png'

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80
/** Within this many pixels of the bottom, the transcript follows new lines. */
const FOLLOW_SLACK = 160

/** How long a toast stays up. */
const TOAST_MS = 6000

/** Smallest share of the column either pane can be stepped down to with the keyboard. */
const MIN_PANE = 0.15
/** Smallest height either pane can be dragged down to, in pixels. */
const MIN_PANE_PX = 120
/** Dragging a pane shorter than this closes it, so between here and the minimum the bar snaps. */
const CLOSE_PANE_PX = 64
/** The page column keeps at least this much width, however wide the side panels are dragged. */
const MIN_PAGE_PX = 420
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
  line.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  line.classList.add('search-flash')
  line.addEventListener('animationend', () => line.classList.remove('search-flash'), { once: true })
}

/** "Nov 20, 3:04 PM", with the year only when it isn't this one. */
function startedLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(year ? { year } : {}) })
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
    return window.api.onStatus(setStatus)
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

  /**
   * Records into a session: the mic, plus the computer's audio when that setting is on or the
   * recording is of a meeting (the other people are only in the computer's audio).
   */
  const record = useCallback(
    (pageId: string, meeting = false): Promise<StartResult> =>
      start({ pageId, systemAudio: meeting || (settingsRef.current?.captureSystemAudio ?? true) }),
    [start]
  )

  const phaseRef = useRef(dictation.phase)
  phaseRef.current = dictation.phase
  /** A new session is being made; a second request meanwhile would only add an empty one. */
  const sessionStarting = useRef(false)

  /** A new session, named for this moment, recording straight away. */
  const startSession = useCallback(
    async (meeting = false) => {
      if (sessionStarting.current) return
      sessionStarting.current = true
      try {
        if (phaseRef.current === 'finishing') {
          notify('Starting a new session once the last recording finishes transcribing.')
        }
        // Waits for a recording that's still finishing, too: main records one at a time.
        await stop()
        // A new recording shows its transcript arriving, whatever the last session's layout was.
        setPaneMode('split')
        const page = await create({ startedAt: new Date().toISOString() })
        const result = await record(page.id, meeting)
        if (result !== 'failed' && result !== 'cancelled') return
        // Nothing was recorded: don't leave an empty "Untitled" behind for every failed try.
        // Only while it's still open and untouched; `remove` adds no undo toast for it.
        const open = currentRef.current
        const untouched =
          open?.id === page.id &&
          open.title === page.title &&
          !open.body.trim() &&
          !open.summary.trim() &&
          open.transcript.length === 0 &&
          open.tags.length === 0
        if (untouched) await remove(page.id)
      } finally {
        sessionStarting.current = false
      }
    },
    [stop, create, record, remove, currentRef]
  )

  // Commands from the tray, the global hotkey, and the overlay pill.
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  useEffect(
    () =>
      window.api.onSessionCommand((command) => {
        const open = currentRef.current
        const action = sessionCommandAction(command, phaseRef.current, document.hasFocus() && open !== null)
        switch (action.do) {
          case 'start':
            void startSession(action.meeting)
            break
          case 'continue':
            if (open) void record(open.id)
            else void startSession()
            break
          case 'stop':
            void stop()
            break
          case 'ignore':
            if (action.notice) notify(action.notice)
            break
        }
      }),
    [stop, startSession, record, currentRef]
  )

  /**
   * Ctrl/Cmd+N, the sidebar and the palette: a new session. One already recording would be cut
   * off by it, so that asks first.
   */
  const [confirmNew, setConfirmNew] = useState(false)
  const cancelNew = useCallback(() => setConfirmNew(false), [])
  const newSession = useCallback(() => {
    if (recordingRef.current) setConfirmNew(true)
    else void startSession()
  }, [startSession])

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
    requestAnimationFrame(() => view.scrollTo({ top: view.scrollHeight, behavior: scrollBehavior() }))
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
  // Stable handlers for the memoized sidebar, so typing in the notes doesn't redraw it.
  const openPageRef = useRef(openPage)
  openPageRef.current = openPage
  const openFromSidebar = useCallback((id: string) => void openPageRef.current(id), [])
  const openSettings = useCallback(() => setShowSettings(true), [])

  const tasks = useActivity()
  const pageTitle = useCallback(
    (id: string): string | null => {
      const page = pages.find((entry) => entry.id === id)
      return page ? page.title || 'Untitled' : null
    },
    [pages]
  )
  useActivityEndings(
    tasks.items,
    (item) => (item.origin === 'settings' ? showSettings : item.origin === 'session' && item.pageId === current?.id),
    (item) => {
      const session = item.pageId ? pageTitle(item.pageId) : null
      const text = session ? `${item.title}: ${session}` : item.title
      const { pageId } = item
      if (pageId) notify(text, { label: 'Open', run: () => void openPageRef.current(pageId) })
      else if (item.origin === 'settings') notify(text, { label: 'Open Settings', run: () => setShowSettings(true) })
      else notify(text)
    }
  )
  const openSearch = useCallback(() => setShowSearch(true), [])

  const [toast, setToast] = useState<ToastMessage | null>(null)
  // The toast under the pointer or holding focus; it stays up until it's let go.
  const [heldToast, setHeldToast] = useState<ToastMessage | null>(null)
  const toastHeld = toast !== null && heldToast === toast
  const toastButton = useRef<HTMLButtonElement>(null)
  // Where focus was before F6 jumped to the toast's button, to go back there afterwards.
  const toastReturn = useRef<Element | null>(null)
  useEffect(() => {
    if (!toast || toastHeld) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast, toastHeld])
  const showToast = useCallback((next: ToastMessage) => {
    setToast((current) => (replacesToast(current, next) ? next : current))
  }, [])
  const leaveToast = useCallback(() => {
    const back = toastReturn.current
    toastReturn.current = null
    if (back instanceof HTMLElement && back.isConnected) back.focus()
  }, [])

  useEffect(() => onToast(showToast), [showToast])

  // Every undoable action outside a session's document says what it did, with Undo or Redo.
  useEffect(
    () =>
      onHistory((event) => {
        if (event.quiet && event.kind === 'done') return
        showToast(
          event.kind === 'undone'
            ? { text: event.undoneLabel, action: { label: 'Redo', run: () => void redoAction() } }
            : { text: event.label, action: { label: 'Undo', run: () => void undoAction() } }
        )
      }),
    [showToast]
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

  const activity = dockActivity(status, progress ? behindLabel(progress) : null)
  const activityElement = activity ? <ActivityToast activity={activity} /> : null

  // Hovering or focusing the toast holds it; F6 reaches its button from anywhere (see onKey).
  const toastElement = toast ? (
    <Toast
      role="status"
      text={toast.text}
      onDismiss={() => {
        setToast(null)
        leaveToast()
      }}
      onMouseMove={() => {
        if (heldToast !== toast) setHeldToast(toast)
      }}
      onMouseLeave={() => setHeldToast(null)}
      onFocus={() => setHeldToast(toast)}
      onBlur={() => setHeldToast(null)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setToast(null)
        leaveToast()
      }}
      action={
        toast.action ? (
          <button
            ref={toastButton}
            type="button"
            className="toast-action"
            aria-keyshortcuts="F6"
            {...tip(toast.action.label, 'F6')}
            onClick={() => {
              toast.action?.run()
              setToast(null)
              leaveToast()
            }}
          >
            {toast.action.label}
          </button>
        ) : null
      }
    />
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

  // Mid-drag, a side panel opens and closes here first; the setting follows when the drag ends.
  const [sidebarLive, setSidebarLive] = useState<boolean | null>(null)
  const [detailsLive, setDetailsLive] = useState<boolean | null>(null)
  const sidebarOpen = sidebarLive ?? settings?.sidebar ?? true
  const panel = detailsLive ?? settings?.detailsPanel ?? false
  const sidebarWidth = settings?.sidebarWidth ?? PANEL_WIDTHS.sidebar.initial
  const detailsWidth = settings?.detailsWidth ?? PANEL_WIDTHS.details.initial
  const appRef = useRef<HTMLDivElement>(null)
  // The resizers write these straight onto the element while dragging, so React stays out of it.
  useLayoutEffect(() => {
    appRef.current?.style.setProperty('--sidebar-width', `${String(sidebarWidth)}px`)
    appRef.current?.style.setProperty('--details-width', `${String(detailsWidth)}px`)
  }, [sidebarWidth, detailsWidth])

  const toggleLayout = useCallback(() => {
    void updateSettings({ detailsPanel: !(settingsRef.current?.detailsPanel ?? false) })
  }, [updateSettings])
  const toggleSidebar = useCallback(() => {
    void updateSettings({ sidebar: !(settingsRef.current?.sidebar ?? true) })
  }, [updateSettings])

  const commitSidebar = (layout: PanelLayout): void => {
    setSidebarLive(layout.open)
    void updateSettings({ sidebar: layout.open, sidebarWidth: layout.width }).finally(() =>
      setSidebarLive(null)
    )
  }
  const commitDetails = (layout: PanelLayout): void => {
    setDetailsLive(layout.open)
    void updateSettings({ detailsPanel: layout.open, detailsWidth: layout.width }).finally(() =>
      setDetailsLive(null)
    )
  }

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
      // F6 jumps to the toast's action (Undo, Move them…) before it times out.
      if (event.key === 'F6' && !event.metaKey && !event.ctrlKey && toastButton.current) {
        event.preventDefault()
        toastReturn.current = document.activeElement
        toastButton.current.focus()
        return
      }
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
        newSession()
      } else if (key === '.') {
        event.preventDefault()
        toggleLayout()
      } else if (key === '\\') {
        event.preventDefault()
        toggleSidebar()
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
  }, [toggleDictation, newSession, toggleLayout, toggleSidebar, undo, redo, undoLatest, currentRef])

  // Counted apart so typing in the notes doesn't re-count a long transcript on every keystroke
  // (`usePages` keeps the transcript array the same object until it changes).
  const openTranscript = current?.transcript
  const transcriptWords = useMemo(
    () => (openTranscript ? wordCount(openTranscript.map((line) => line.text).join(' ')) : 0),
    [openTranscript]
  )
  const words = current ? wordCount(`${current.summary} ${current.body}`) + transcriptWords : 0
  const summary = current ? pages.find((page) => page.id === current.id) : undefined
  const editedAt = summary?.updatedAt
  const startedAt = summary?.startedAt
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
  const summaryText = current?.summary ?? ''
  const sections = useMemo(() => summarySections(summaryText), [summaryText])
  const transcriptLines = useMemo(() => current?.transcript ?? [], [current?.transcript])
  const sectionsNav = useSectionsNav(sections, transcriptLines, scroller)

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
    const bar = handle.getBoundingClientRect().height
    // A drag from a collapsed or expanded layout opens the split where the pointer is. Dragged
    // close to either end, the pane there closes; short of that, it holds at its minimum.
    const move = (next: PointerEvent): void => {
      const above = next.clientY - box.top
      const below = box.height - bar - above
      if (above < CLOSE_PANE_PX) setPaneMode('transcript')
      else if (below < CLOSE_PANE_PX) setPaneMode('notes')
      else {
        const notesPx = Math.min(box.height - bar - MIN_PANE_PX, Math.max(MIN_PANE_PX, above))
        setPaneMode('split')
        setSplit(notesPx / box.height)
      }
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={appRef}
      className={`app platform-${window.api.platform}${sidebarOpen ? '' : ' sidebar-closed'}`}
    >
      {sidebarOpen ? (
        <Sidebar
          pages={pages}
          activeId={current?.id}
          recordingId={recordingId}
          onOpen={openFromSidebar}
          onCreate={newSession}
          onDelete={setConfirmDelete}
          onSettings={openSettings}
          settingsIssue={settingsIssues.length > 0}
          onSearch={openSearch}
          tags={knownTags}
          tagFilter={tagFilter}
          onTagFilter={setTagFilter}
        />
      ) : null}
      <PanelResizer
        side="left"
        layout={{ open: sidebarOpen, width: sidebarWidth }}
        limits={PANEL_WIDTHS.sidebar}
        target={appRef}
        cssVar="--sidebar-width"
        room={() => window.innerWidth - (current && panel ? detailsWidth : 0) - MIN_PAGE_PX}
        label="Resize sidebar"
        onOpenChange={setSidebarLive}
        onCommit={commitSidebar}
      />
      {current ? (
        <PanelResizer
          side="right"
          layout={{ open: panel, width: detailsWidth }}
          limits={PANEL_WIDTHS.details}
          target={appRef}
          cssVar="--details-width"
          room={() => window.innerWidth - (sidebarOpen ? sidebarWidth : 0) - MIN_PAGE_PX}
          label="Resize details panel"
          onOpenChange={setDetailsLive}
          onCommit={commitDetails}
        />
      ) : null}

      <main className={current && panel ? 'workspace with-panel' : 'workspace'}>
        {/* The panel runs the full height beside this column, so its header shares the top band. */}
        <div className="workspace-main">
        <header className="topbar drag">
          {sidebarOpen ? null : (
            <button
              className="icon-btn no-drag sidebar-toggle"
              type="button"
              aria-label="Show sidebar"
              {...tip('Show sidebar', shortcutLabel('\\'))}
              onClick={toggleSidebar}
            >
              <SidebarIcon />
            </button>
          )}
          {sidebarOpen ? null : (
            <ActivityButton
              visible={tasks.visible}
              pageTitle={pageTitle}
              onOpen={(id) => void openPageRef.current(id)}
            />
          )}
          <div className="brand">
            <img src={lyraIcon} alt="" width={24} height={24} />
            <span>Lyra</span>
          </div>
          {current ? (
            <>
              <div className="topbar-actions">
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
            {/* Above both panes, so the title stays in view however the notes or transcript scroll. */}
            <div className="session-head">
              <div className="page">
                {/* A textarea so a long title wraps; Enter moves on to the notes instead. */}
                <textarea
                  className="title-input"
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
              </div>
            </div>
            <div className="panes" ref={column}>
            <ErrorBoundary scope="session" variant="pane" resetKey={current.id}>
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
                      {/* When it started and when it last changed are different facts; both are shown. */}
                      {startedAt ? <span>Started {startedLabel(startedAt)}</span> : null}
                      {editedAt ? <span>Edited {relativeTime(editedAt).toLowerCase()}</span> : null}
                    </p>
                    <TagRow tags={current.tags} known={knownTags} onAdd={tag} onRemove={untag} />
                  </>
                )}
                {current.summary.trim() ? (
                  <Summary
                    key={`summary-${current.id}`}
                    pageId={current.id}
                    value={current.summary}
                    onChange={editSummary}
                    canRewrite={(settings?.notesEngine ?? 'off') !== 'off'}
                  />
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
                  <SectionsMenu nav={sectionsNav} />
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
                    <SectionsRail nav={sectionsNav} />
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
            </ErrorBoundary>
            </div>
            {find ? (
              <FindBar root={column} initial={find.initial} request={find.request} onClose={closeFind} />
            ) : null}
            <DictationDock
              phase={dictation.phase}
              micName={dictation.micName}
              micDeviceId={settings?.micDeviceId ?? null}
              onMicChange={(micDeviceId) => void updateSettings({ micDeviceId })}
              systemAudio={systemAudio}
              onSystemAudioChange={(captureSystemAudio) => void updateSettings({ captureSystemAudio })}
              subscribeLevel={dictation.subscribeLevel}
              transcribing={transcribing}
              onToggle={toggleDictation}
              startedAt={listeningSince}
              elsewhere={elsewhere}
            />
            <ToastStack>
              <ProcessingToast pageId={current.id} />
              {activityElement}
              {dictation.recording && systemAudio && settings && !settings.meetingNoticeSeen ? (
                <Toast
                  role="status"
                  icon="dot"
                  text="Recording the computer’s audio too. Make sure everyone on the call is OK with it."
                  action={
                    <button
                      className="toast-action"
                      type="button"
                      onClick={() => void updateSettings({ meetingNoticeSeen: true })}
                    >
                      Got it
                    </button>
                  }
                />
              ) : null}
              <DictationMessage
                error={dictation.error}
                notice={dictation.notice}
                onDismiss={dictation.dismissMessage}
              />
              {toastElement}
            </ToastStack>
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
              <button className="btn primary" type="button" onClick={newSession}>
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
            <ToastStack>
              {activityElement}
              {toastElement}
            </ToastStack>
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
              run: newSession
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
              id: 'sidebar',
              label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
              keywords: 'layout sessions list',
              shortcut: shortcutLabel('\\'),
              icon: <SidebarIcon />,
              run: toggleSidebar
            },
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

      {confirmNew ? (
        <ConfirmDialog
          title={`Stop recording “${recordingPage?.title ? recordingPage.title : 'Untitled'}”?`}
          confirm="Stop and start new"
          onConfirm={() => {
            setConfirmNew(false)
            void startSession()
          }}
          onCancel={cancelNew}
        >
          A new session can only start once this recording stops. What’s been recorded so far is
          kept and finishes transcribing.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PANEL_WIDTHS } from '../../shared/settings'
import { summarySections } from '../../shared/summarySections'
import type { PageSummary, WhisperStatus } from '../../shared/types'
import type { TranscriptSegment } from '../../shared/sessionDoc'
import { DictationMessage, RecordControl, SystemAudioMessage } from './components/Capture'
import { useContextMenu } from './components/ContextMenu'
import { SummaryButton } from './components/SummaryButton'
import { SummaryPane } from './components/SummaryPane'
import { PlayerBar } from './components/PlayerBar'
import { Home } from './components/Home'
import { PeopleOverview, PersonPage } from './components/PeoplePages'
import { Split } from './components/Split'
import { Progress } from './components/ui/progress'
import { ActivityToast, Toast, ToastStack } from './components/ToastStack'
import { Summary } from './components/Summary'
import { NotesEditor, referenceMarkdown, type NotesHandle } from './components/NotesEditor'
import { TagRow } from './components/TagRow'
import { ScrollArea, Segmented } from './components/Controls'
import { Transcript } from './components/Transcript'
import { useSectionsNav } from './components/TranscriptSections'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from './components/ui/dropdown-menu'
import {
  ChevronDownIcon,
  CopyIcon,
  SendIcon,
  FolderIcon,
  HomeIcon,
  ListIcon,
  LocalIcon,
  LyraIcon,
  GearIcon,
  MicIcon,
  MoreIcon,
  PeopleIcon,
  PlusIcon,
  RecordDotIcon,
  RevealIcon,
  SearchIcon,
  SidebarIcon,
  SpeakerIcon,
  TrashIcon
} from './components/Icons'
import { SettingsDialog, type SettingsFocus } from './components/Settings'
import { usePeople } from './components/People'
import { useMicrophones } from './hooks/useMicrophones'
import type { SettingsTab } from './hooks/useSettingsIssues'
import { setDensity, useDensity } from './lib/density'
import { shortDeviceName } from './lib/deviceName'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FindBar } from './components/FindBar'
import { PanelResizer, type PanelLayout } from './components/PanelResizer'
import { TooltipLayer } from './components/Tooltip'
import { useActivity } from './hooks/useActivity'
import { useActivityEndings } from './hooks/useActivityEndings'
import { useDictation, type DictationPhase, type StartResult } from './hooks/useDictation'
import { sessionCommandAction } from './hooks/sessionCommands'
import { usePages } from './hooks/usePages'
import { useSettings } from './hooks/useSettings'
import { useSettingsIssues } from './hooks/useSettingsIssues'
import { clockLabel, homePath, relativeTime, shortcutLabel, wordCount } from './lib/format'
import { useWidthClass } from './lib/layout'
import { cn } from './lib/utils'
import {
  onHistory,
  perform,
  redo as redoAction,
  redoAt as historyRedoAt,
  undo as undoAction,
  undoAt as historyUndoAt
} from './lib/history'
import { drawAttention, scrollBehavior } from './lib/motion'
import { behindLabel, dockActivity } from './lib/status'
import { notify, onToast, replacesToast, type ToastMessage } from './lib/toast'
import { tip } from './components/Tooltip'
import { SessionWork, StatusBar } from './components/SessionChrome'
import { RecordingReadout } from './components/Recording'
import { Kbd } from './components/ui/status'
import { overallProvenance } from './lib/provenance'
import { sessionMarkdown } from './lib/sessionMarkdown'
import { usePromptApps } from './hooks/usePromptApps'
import { SendToMenu } from './components/SendToMenu'
import { Button } from './components/ui/button'

/** What shows while no session is open. */
type HomeView = { kind: 'home' } | { kind: 'people' } | { kind: 'person'; personId: string }

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80
/** Within this many pixels of the bottom, the transcript follows new lines. */
const FOLLOW_SLACK = 160

/** How long a toast stays up. */
const TOAST_MS = 6000

/** Preferences sections the launcher can open, with the words people would type for them. */
const PREFERENCE_PAGES: readonly { tab: SettingsTab; section: string; keywords: string }[] = [
  { tab: 'general', section: 'Appearance', keywords: 'density compact comfortable theme look' },
  { tab: 'general', section: 'Storage', keywords: 'notes folder location files save where' },
  { tab: 'general', section: 'Microphone', keywords: 'mic input device permission' },
  { tab: 'general', section: 'Shortcut and startup', keywords: 'hotkey keyboard shortcut login launch' },
  { tab: 'sessions', section: 'Recording', keywords: 'language vocabulary words names audio retention keep delete' },
  { tab: 'sessions', section: 'Summaries', keywords: 'summary notes model ai cloud local key provider' },
  { tab: 'sessions', section: 'Search', keywords: 'search meaning semantic index' },
  { tab: 'sessions', section: 'Prompts', keywords: 'call meeting prompt offer apps ignore' },
  { tab: 'people', section: 'Saved voices', keywords: 'people voices speakers enroll voiceprint me' },
  { tab: 'performance', section: 'Resource use', keywords: 'performance cpu memory gpu health usage' },
  { tab: 'about', section: 'About Lyra', keywords: 'version update about diagnostics' }
]

/** The transcript's share of the panes when the split is reset. */
const DEFAULT_SPLIT = 0.56
/** The session column keeps at least this much width, however wide the library is dragged. */
const MIN_PAGE_PX = 420

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


/** A field with its own text history (search, rename, settings): undo stays native there. */
function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button'].includes(target.type)
  return target instanceof HTMLElement && target.isContentEditable
}

/** A quote of the transcript for the notes: the words, then who said them and when. */
function quoteLabel(text: string, who: string | null, start: number): string {
  const said = text.replace(/\s+/g, ' ').trim()
  const short = said.length > 48 ? `${said.slice(0, 46).trimEnd()}…` : said
  return `“${short}” · ${who ? `${who} ` : ''}${clockLabel(start)}`
}

/** How long to wait for an opened session's transcript to render before giving up. */
const REVEAL_FRAMES = 60

/** Scrolls a transcript line into view and flashes it, once the opened session renders it. */
function revealLine(lineId: string, frame = 0, behavior?: ScrollBehavior): void {
  const text = document.querySelector(`[data-line="${CSS.escape(lineId)}"]`)
  const line = text?.closest('.line')
  if (!line) {
    if (frame < REVEAL_FRAMES) requestAnimationFrame(() => revealLine(lineId, frame + 1, behavior))
    return
  }
  line.scrollIntoView({ block: 'center', behavior: behavior ?? scrollBehavior() })
  drawAttention(line)
}

/** "Nov 20, 3:04 PM", with the year only when it isn't this one. */
function startedLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(year ? { year } : {}) })
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
  } = usePages()
  const [status, setStatus] = useState<WhisperStatus>({ state: 'idle' })
  const [copied, setCopied] = useState(false)
  const { settings, update: updateSettings } = useSettings()
  const settingsIssues = useSettingsIssues(settings)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus | null>(null)
  const closeSettings = useCallback(() => {
    setShowSettings(false)
    setSettingsFocus(null)
  }, [])
  const openSettingsAt = useCallback((focus: SettingsFocus) => {
    setSettingsFocus(focus)
    setShowSettings(true)
  }, [])
  const { microphones } = useMicrophones()
  const people = usePeople()
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
  /** The transcript's share of the panes. */
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const width = useWidthClass()
  const density = useDensity()
  /** Below 900 px the library is a drawer over the session, closed until asked for. */
  const drawer = width === 'compact' || width === 'medium'
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    if (!drawer) setDrawerOpen(false)
  }, [drawer])
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])
  const [compactTab, setCompactTab] = useState<'transcript' | 'notes' | 'summary'>('transcript')
  /** How many lines the transcript had when the person scrolled up to reread; null when following. */
  const [away, setAway] = useState<number | null>(null)
  const sessionMenu = useContextMenu()
  const promptApps = usePromptApps()

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
  const { phase, micName, subscribeLevel } = dictation
  // The source choice is locked while recording, so the setting is what's being captured.
  const reportedSystemAudio = settings?.captureSystemAudio ?? true
  const [listeningSince, setListeningSince] = useState<number | null>(null)
  const sinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (phase === 'listening') sinceRef.current ??= Date.now()
    if (phase === 'idle') sinceRef.current = null
    setListeningSince(sinceRef.current)
    window.api.reportSession({
      phase,
      startedAt: sinceRef.current,
      micName,
      systemAudio: reportedSystemAudio
    })
  }, [phase, micName, reportedSystemAudio])

  useEffect(() => {
    let last = 0
    return subscribeLevel((levels) => {
      const now = performance.now()
      if (now - last < OVERLAY_FRAME_MS) return
      last = now
      window.api.reportOverlayFrame({ mic: levels.mic, system: levels.system })
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
    setAway(null)
    await open(id)
  }
  // Stable handlers for the memoized sidebar, so typing in the notes doesn't redraw it.
  const openPageRef = useRef(openPage)
  openPageRef.current = openPage
  const openFromSidebar = useCallback((id: string) => void openPageRef.current(id), [])
  /** What shows while no session is open: Home, the People list, or one person. */
  const [homeView, setHomeView] = useState<HomeView>({ kind: 'home' })
  const goHome = useCallback(() => {
    setFind(null)
    setHomeView({ kind: 'home' })
    void close()
  }, [close])
  const goPeople = useCallback(
    (personId?: string) => {
      setFind(null)
      setHomeView(personId ? { kind: 'person', personId } : { kind: 'people' })
      void close()
    },
    [close]
  )
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

  const activity = dockActivity(status, dictation.progress ? behindLabel(dictation.progress) : null)
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
    window.api.copyText(sessionMarkdown(current))
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
  const sidebarOpen = sidebarLive ?? settings?.sidebar ?? true
  const sidebarWidth = settings?.sidebarWidth ?? PANEL_WIDTHS.sidebar.initial
  const appRef = useRef<HTMLDivElement>(null)
  // The resizers write these straight onto the element while dragging, so React stays out of it.
  useLayoutEffect(() => {
    appRef.current?.style.setProperty('--sidebar-width', `${String(sidebarWidth)}px`)
  }, [sidebarWidth])

  const toggleSidebar = useCallback(() => {
    if (drawer) setDrawerOpen((open) => !open)
    else void updateSettings({ sidebar: !(settingsRef.current?.sidebar ?? true) })
  }, [updateSettings, drawer])

  const commitSidebar = (layout: PanelLayout): void => {
    setSidebarLive(layout.open)
    void updateSettings({ sidebar: layout.open, sidebarWidth: layout.width }).finally(() =>
      setSidebarLive(null)
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
  // A request is consumed once the transcript opens the picker; left set, a transcript remounted
  // by a layout change (a narrower window) would open it again.
  useEffect(() => {
    if (!pickerRequest) return
    const frame = requestAnimationFrame(() => setPickerRequest(null))
    return () => cancelAnimationFrame(frame)
  }, [pickerRequest])

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
  }, [toggleDictation, newSession, toggleSidebar, undo, redo, undoLatest, currentRef])

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
  const engine = {
    notesEngine: settings?.notesEngine ?? 'off',
    cloudProvider: settings?.cloudProvider ?? 'anthropic',
    cloudBaseUrl: settings?.cloudBaseUrl ?? null
  } as const
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
  const transcribing = (dictation.progress?.queued ?? 0) > 0
  const pending = recordingHere ? { working: transcribing, finishing: dictation.phase === 'finishing' } : null
  const hasTranscript = !!current && (current.transcript.length > 0 || pending !== null)
  const summaryText = current?.summary ?? ''
  const sections = useMemo(() => summarySections(summaryText), [summaryText])
  const transcriptLines = useMemo(() => current?.transcript ?? [], [current?.transcript])
  const sectionsNav = useSectionsNav(sections, transcriptLines, scroller)
  const [transcriptRange, setTranscriptRange] = useState<{ from: number; to: number } | null>(null)
  useEffect(() => {
    const view = scroller.current
    const lines = current?.transcript
    if (!view || !lines?.length) {
      setTranscriptRange(null)
      return
    }
    let frame = 0
    const measure = (): void => {
      frame = 0
      const rows = view.querySelectorAll<HTMLElement>('[data-row]')
      if (!rows.length) return
      const box = view.getBoundingClientRect()
      // Rows are in line order: binary search for the first below the top and the last above
      // the bottom, so a long transcript costs a handful of measurements, not one per line.
      const search = (test: (row: DOMRect) => boolean): number => {
        let low = 0
        let high = rows.length - 1
        let found = rows.length
        while (low <= high) {
          const mid = (low + high) >> 1
          const row = rows[mid]
          if (row && test(row.getBoundingClientRect())) {
            found = mid
            high = mid - 1
          } else low = mid + 1
        }
        return found
      }
      const first = Math.min(rows.length - 1, search((row) => row.bottom > box.top))
      const last = Math.max(first, search((row) => row.top >= box.bottom) - 1)
      const from = lines[first]?.start
      const to = lines[Math.min(last, lines.length - 1)]?.end
      if (from !== undefined && to !== undefined) {
        setTranscriptRange((was) => (was?.from === from && was.to === to ? was : { from, to }))
      }
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    schedule()
    view.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(view)
    return () => {
      view.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [current?.transcript, current?.id, width, compactTab])
  const sectionAt = useMemo(() => {
    const at = new Map<string, { start: number; title: string; summary: string }>()
    sectionsNav.firstLines.forEach((id, index) => {
      const section = sections[index]
      if (id && section && !at.has(id)) at.set(id, { start: section.start, title: section.title, summary: section.summary })
    })
    return at
  }, [sectionsNav.firstLines, sections])

  const quote = (line: TranscriptSegment, text: string): void => {
    const page = currentRef.current
    if (!page) return
    const who = line.cluster ? (page.speakers.find((s) => s.id === line.cluster)?.name ?? null) : null
    notes.current?.append(referenceMarkdown(quoteLabel(text, who, line.start), line.id))
  }

  const recordPhase: DictationPhase = dictation.phase
  const continues = !!current && (current.body.trim() !== '' || current.transcript.length > 0)
  const recordControl = current ? (
    <RecordControl
      phase={recordPhase}
      continues={continues}
      systemAudio={systemAudio}
      onSystemAudioChange={(captureSystemAudio) => void updateSettings({ captureSystemAudio })}
      onToggle={toggleDictation}
      elsewhere={elsewhere}
      size={width === 'compact' ? 'sm' : 'lg'}
      subscribeLevel={dictation.subscribeLevel}
      readout={
        recordingHere && listening ? (
          <RecordingReadout
            startedAt={listeningSince}
            micName={dictation.micName}
            // Mic only in the readout while computer audio isn't actually being recorded.
            systemAudio={dictation.systemAudio === 'live'}
            subscribeLevel={dictation.subscribeLevel}
          />
        ) : null
      }
    />
  ) : null

  const sidebarShown = sidebarOpen && !drawer
  const transcriptCount = current?.transcript.length ?? 0
  const newLines = away === null ? 0 : Math.max(0, transcriptCount - away)

  const summaryCard = current ? (
    current.summary.trim() ? (
      <Summary
        key={`summary-${current.id}`}
        pageId={current.id}
        value={current.summary}
        onChange={editSummary}
        canRewrite={engine.notesEngine !== 'off'}
      />
    ) : engine.notesEngine !== 'off' && hasTranscript ? (
      <section className="grid justify-items-start gap-2" aria-label="Summary">
        <h3 className="m-0 text-title-2 font-semibold">Summary</h3>
        <p className="m-0 text-body-sm text-text-2">This meeting has no summary yet.</p>
        <SummaryButton pageId={current.id} hasSummary={false} />
      </section>
    ) : null
  ) : null

  const transcriptPane = current ? (
    <section className="transcript-pane relative flex min-h-0 min-w-0 flex-col" aria-label="Transcript">
      <header className="pane-head flex min-h-11 flex-wrap items-center gap-2 px-4 pt-3 pb-1.5">
        <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Transcript</h2>
        <span className="text-label text-text-3">
          {recordingHere ? '· speakers update every 30 s' : `· ${String(transcriptCount)} ${transcriptCount === 1 ? 'line' : 'lines'}`}
        </span>
        {sections.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="toc-trigger max-w-[260px] min-w-0" aria-label="Sections">
                <ListIcon />
                <span className="truncate">{sections[sectionsNav.current]?.title ?? 'Sections'}</span>
                <ChevronDownIcon className="text-text-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[340px]">
              <DropdownMenuLabel>Sections</DropdownMenuLabel>
              {sections.map((section, index) => (
                <DropdownMenuItem
                  key={`${String(section.start)}-${section.title}`}
                  className={cn('h-auto min-h-[30px] items-start py-1.5', index === sectionsNav.current && 'bg-brand-soft')}
                  aria-current={index === sectionsNav.current ? 'location' : undefined}
                  onSelect={() => sectionsNav.jump(index)}
                >
                  <span className="w-[46px] shrink-0 font-mono text-label leading-5 text-brand-text">{clockLabel(section.start)}</span>
                  <span className="min-w-0">{section.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      <ScrollArea
        ref={scroller}
        className="scroller @container min-h-0 flex-1 px-2 pb-24"
        onScroll={(event) => {
          const view = event.currentTarget
          const near = view.scrollHeight - view.scrollTop - view.clientHeight <= FOLLOW_SLACK
          setAway((was) => (near ? null : (was ?? transcriptCount)))
        }}
      >
        <Transcript
          pageId={current.id}
          transcript={current.transcript}
          speakers={current.speakers}
          hasSummary={!!current.summary.trim()}
          notesEngine={engine.notesEngine}
          onEditLine={editSegment}
          onEditOverlay={editLineOverlay}
          onQuote={quote}
          onAssign={assignLines}
          onSplitLine={splitLine}
          onName={nameSpeaker}
          onUndo={() => void undo()}
          showSpeakersBar={false}
          pickerRequest={pickerRequest}
          transcribing={pending}
          sectionAt={sectionAt}
          onReference={(label, lineId) => notes.current?.append(referenceMarkdown(label, lineId))}
        />
      </ScrollArea>
      <PlayerBar pageId={current.id} lines={current.transcript} />
      {followHere && newLines > 0 ? (
        <button
          type="button"
          className="jump-live absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border-(length:--border-width) border-border bg-popover px-3 py-1 text-label shadow-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            const view = scroller.current
            view?.scrollTo({ top: view.scrollHeight, behavior: scrollBehavior() })
            setAway(null)
          }}
        >
          ↓ {newLines} new {newLines === 1 ? 'line' : 'lines'} · Jump to live <Kbd>End</Kbd>
        </button>
      ) : null}
    </section>
  ) : null

  const notesBlock = current ? (
    <section className="notes-pane grid content-start gap-2" aria-label="Your notes">
      <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Your notes</h2>
      <NotesEditor
        key={current.id}
        ref={notes}
        value={current.body}
        onChange={(body) => edit({ body })}
        onReference={(lineId) => revealLine(lineId, 0, 'instant')}
        placeholder={
          hasTranscript
            ? 'Type freely while recording. Add a transcript line here from its menu.'
            : 'Start a recording, or just type. Your notes save automatically.'
        }
      />
    </section>
  ) : null

  const summaryPane = current ? (
    <SummaryPane
      page={current}
      summary={summaryCard}
      sections={sections}
      view={transcriptRange}
      onSpeaker={(speaker, target) => setPickerRequest({ speaker, anchor: target.getBoundingClientRect() })}
      onSeek={(seconds) => {
        const line = current.transcript.find((entry) => entry.end >= seconds) ?? current.transcript.at(-1)
        if (line) revealLine(line.id, 0, 'instant')
      }}
    />
  ) : null

  const pad = 'px-4 pt-3.5 pb-24'
  let panes: React.ReactNode = null
  if (current && !hasTranscript) {
    // A dictation: notes alone, at the reading measure; a summary, if any, above them.
    panes = (
      <ScrollArea className="scroller min-h-0 min-w-0">
        <div className={cn('mx-auto grid w-full max-w-[76ch] gap-4', pad)}>
          {summaryCard}
          {notesBlock}
        </div>
      </ScrollArea>
    )
  } else if (current && width === 'compact') {
    panes = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-3 py-2">
          <Segmented
            className="flex w-full [&>button]:flex-1"
            label="Show"
            value={compactTab}
            options={[
              { value: 'transcript', label: 'Transcript' },
              { value: 'notes', label: 'Notes' },
              { value: 'summary', label: 'Summary' }
            ]}
            onChange={setCompactTab}
          />
        </div>
        {compactTab === 'transcript' ? (
          transcriptPane
        ) : (
          <ScrollArea className="scroller min-h-0 flex-1">
            <div className={cn('grid gap-4', pad)}>{compactTab === 'notes' ? notesBlock : summaryPane}</div>
          </ScrollArea>
        )}
      </div>
    )
  } else if (current) {
    panes = (
      <Split
        direction={width === 'medium' ? 'column' : 'row'}
        value={split}
        onChange={setSplit}
        initial={DEFAULT_SPLIT}
        label="Resize transcript and notes"
        className="flex-1"
        first={transcriptPane}
        second={
          <ScrollArea className="scroller min-h-0 min-w-0">
            <div className={cn('grid gap-5', pad)}>
              {notesBlock}
              {summaryPane}
            </div>
          </ScrollArea>
        }
      />
    )
  }

  const sidebar = (
    <Sidebar
      pages={pages}
      activeId={current?.id}
      recordingId={recordingId}
      onOpen={(id) => {
        if (drawer) setDrawerOpen(false)
        openFromSidebar(id)
      }}
      onCreate={newSession}
      onDelete={setConfirmDelete}
      onSettings={openSettings}
      settingsIssue={settingsIssues.length > 0}
      onSearch={openSearch}
      tags={knownTags}
      tagFilter={tagFilter}
      onTagFilter={setTagFilter}
      onRename={(id) => {
        if (drawer) setDrawerOpen(false)
        void openPageRef.current(id).then(() => {
          // Once the session renders, select its title for typing over.
          requestAnimationFrame(() => {
            const field = document.querySelector<HTMLTextAreaElement>('.title-input')
            field?.focus()
            field?.select()
          })
        })
      }}
      canSummarize={engine.notesEngine !== 'off'}
      onHome={() => {
        if (drawer) setDrawerOpen(false)
        goHome()
      }}
      homeActive={!current && homeView.kind === 'home'}
      onPeople={() => {
        if (drawer) setDrawerOpen(false)
        goPeople()
      }}
      peopleActive={!current && homeView.kind !== 'home'}
    />
  )

  const sidebarToggle = sidebarShown ? null : (
    <Button
      variant="ghost"
      size="icon"
      className="no-drag sidebar-toggle shrink-0"
      aria-label="Show sessions"
      aria-expanded={drawer ? drawerOpen : false}
      {...tip('Show sessions', shortcutLabel('\\'))}
      onClick={toggleSidebar}
    >
      <SidebarIcon />
    </Button>
  )

  return (
    <div
      ref={appRef}
      className={`app platform-${window.api.platform} width-${width}${sidebarShown ? '' : ' sidebar-closed'}`}
    >
      {sidebarShown ? sidebar : null}
      {!drawer ? (
        <PanelResizer
          side="left"
          layout={{ open: sidebarOpen, width: sidebarWidth }}
          limits={PANEL_WIDTHS.sidebar}
          target={appRef}
          cssVar="--sidebar-width"
          room={() => window.innerWidth - MIN_PAGE_PX}
          label="Resize sidebar"
          onOpenChange={setSidebarLive}
          onCommit={commitSidebar}
        />
      ) : null}
      {drawer && drawerOpen ? (
        // At medium and compact widths the library is a drawer over the session.
        <div className="fixed inset-0 z-50 bg-(--backdrop)" onMouseDown={() => setDrawerOpen(false)}>
          <div
            className="library-drawer flex h-full w-[min(300px,90vw)] flex-col shadow-md [&>.sidebar]:flex-1"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {sidebar}
          </div>
        </div>
      ) : null}

      <main className="workspace">
        <div className="workspace-main">
          {current ? (
            <>
              <header
                className={cn(
                  'session-head drag flex flex-wrap items-start gap-x-2.5 gap-y-1 border-b border-border bg-background pt-3 pb-2.5 pl-5',
                  !sidebarShown && window.api.platform === 'darwin' && 'pl-[84px]'
                )}
                style={{ paddingRight: 'calc(20px + var(--caption-buttons))' }}
              >
                {sidebarToggle}
                {/* A textarea so a long title wraps; Enter moves on to the notes instead. */}
                <textarea
                  className="title-input no-drag m-0 min-w-0 flex-[1_1_260px] text-title-1 font-semibold"
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
                <span className="flex shrink-0 items-center gap-1.5">
                  {recordControl}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="no-drag"
                    aria-label="Show in folder"
                    {...tip('Show in folder')}
                    onClick={() => void window.api.revealPage(current.id)}
                  >
                    <RevealIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="no-drag"
                    aria-label="More actions"
                    aria-haspopup="menu"
                    {...tip('More actions')}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      sessionMenu.openAt({
                        x: Math.max(8, rect.right - 240),
                        y: rect.bottom + 4,
                        label: 'Session actions',
                        items: [
                          { label: copied ? 'Copied' : 'Copy as Markdown', icon: <CopyIcon />, run: copy },
                          ...(promptApps.length
                            ? [
                                {
                                  label: 'Send to…',
                                  icon: <SendIcon />,
                                  next: { label: 'Send to', content: <SendToMenu session={current} apps={promptApps} /> }
                                }
                              ]
                            : []),
                          {
                            label: 'Find in session',
                            icon: <SearchIcon />,
                            shortcut: shortcutLabel('F'),
                            run: () => setFind((open) => ({ initial: open?.initial ?? '', request: (open?.request ?? 0) + 1 }))
                          },
                          { label: 'Show in folder', icon: <RevealIcon />, run: () => void window.api.revealPage(current.id) },
                          'separator',
                          {
                            label: 'Delete session…',
                            icon: <TrashIcon />,
                            danger: true,
                            run: () => {
                              if (summary) setConfirmDelete(summary)
                            }
                          }
                        ]
                      })
                    }}
                  >
                    <MoreIcon />
                  </Button>
                </span>
                <div className="session-meta flex basis-full flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-text-3">
                  {startedAt ? <span className="font-mono">{startedLabel(startedAt)}</span> : null}
                  {summary?.seconds ? <span className="font-mono">{clockLabel(summary.seconds)}</span> : null}
                  {current.speakers.length > 1 ? <span>{current.speakers.length} speakers</span> : null}
                  {!hasTranscript && words > 0 ? (
                    <span>
                      {words} {words === 1 ? 'word' : 'words'}
                    </span>
                  ) : null}
                  {editedAt ? <span>Edited {relativeTime(editedAt).toLowerCase()}</span> : null}
                  <span className="no-drag">
                    <TagRow tags={current.tags} known={knownTags} onAdd={tag} onRemove={untag} />
                  </span>
                </div>
              </header>
              <div className="workspace-column relative min-h-0 flex-1" ref={column}>
                <ErrorBoundary scope="session" variant="pane" resetKey={current.id}>
                  {panes}
                </ErrorBoundary>
                {find ? <FindBar root={column} initial={find.initial} request={find.request} onClose={closeFind} /> : null}
                <ToastStack>
                  {activityElement}
                  {dictation.recording && systemAudio && settings && !settings.meetingNoticeSeen ? (
                    <Toast
                      role="status"
                      icon="dot"
                      text="Recording other people may need their consent. Let them know Lyra is taking notes."
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
                  <DictationMessage error={dictation.error} notice={dictation.notice} onDismiss={dictation.dismissMessage} />
                  {dictation.systemAudioMessageShown ? (
                    <SystemAudioMessage
                      state={dictation.systemAudio}
                      onRetry={dictation.retrySystemAudio}
                      onDismiss={dictation.dismissSystemAudio}
                    />
                  ) : null}
                  {toastElement}
                </ToastStack>
              </div>
            </>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="drag flex h-(--band) shrink-0 items-center px-3" style={{ paddingLeft: !sidebarShown && window.api.platform === 'darwin' ? 84 : undefined }}>
                {sidebarToggle}
              </div>
              {homeView.kind === 'people' ? (
                <PeopleOverview
                  pages={pages}
                  people={people}
                  onOpenPerson={goPeople}
                  onAddPeople={() => openSettingsAt({ tab: 'people', section: 'Saved voices' })}
                />
              ) : homeView.kind === 'person' ? (
                <PersonPage
                  personId={homeView.personId}
                  pages={pages}
                  people={people}
                  onBack={() => goPeople()}
                  onOpenPerson={goPeople}
                  onOpenSession={openFromSidebar}
                />
              ) : pages.length ? (
                <Home pages={pages} recordingId={recordingId} onOpen={openFromSidebar} onNew={newSession} onSearch={openSearch} />
              ) : (
              <div className="empty">
                <div className="grid max-w-[460px] gap-4 px-9 py-9">
                  <span
                    className="grid size-12 place-items-center rounded-[12px] bg-primary text-primary-foreground"
                    aria-hidden="true"
                  >
                    <LyraIcon size={28} />
                  </span>
                  <h2 className="m-0 text-display font-semibold tracking-[-0.01em]">Talk. Lyra writes it down.</h2>
                  <p className="m-0 max-w-[40ch] text-[15px] text-text-2">
                    Start a session and talk, alone or on a call. Your words become a note in a folder you
                    choose.
                  </p>
                  <div className="grid gap-1.5 text-body-sm text-text-2">
                    <span className="flex items-start gap-2">
                      <LocalIcon className="mt-px shrink-0 text-local" />
                      Speech is turned into text on this computer. Nothing is sent anywhere.
                    </span>
                    {settings ? (
                      <span className="flex items-start gap-2" {...tip(settings.notesDir)}>
                        <FolderIcon className="mt-px shrink-0 text-local" />
                        <span>
                          Notes are plain files in{' '}
                          <b className="font-mono text-label font-medium text-foreground">{homePath(settings.notesDir)}</b>
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="lg" onClick={newSession}>
                      <RecordDotIcon />
                      Start a session
                    </Button>
                    <span className="text-label text-text-3">
                      or press <Kbd>{shortcutLabel('N')}</Kbd>
                    </span>
                  </div>
                </div>
              </div>
              )}
              <ToastStack>
                {activityElement}
                {toastElement}
              </ToastStack>
            </div>
          )}
          <StatusBar
            provenance={overallProvenance(engine)}
            work={
              <>
                {current ? <SessionWork pageId={current.id} /> : null}
                {status.state === 'downloading' && status.total ? (
                  <span className="inline-flex items-center gap-2 text-text-2" role="status">
                    <b className="font-medium text-foreground">Downloading the speech model</b>
                    <Progress
                      className="w-24"
                      value={(status.received / status.total) * 100}
                      aria-label="Downloading the speech model"
                    />
                    <span className="font-mono">{Math.round((status.received / status.total) * 100)}%</span>
                  </span>
                ) : null}
              </>
            }
            sessions={pages.length}
            activity={tasks.visible}
            pageTitle={pageTitle}
            onOpen={(id) => void openPageRef.current(id)}
          />
        </div>
        {sessionMenu.element}
      </main>


      {showSearch ? (
        <CommandPalette
          pages={pages}
          activeId={current?.id}
          onOpen={(id, line) => void openPage(id).then(() => line && revealLine(line))}
          onClose={() => setShowSearch(false)}
          commands={[
            ...(current
              ? [
                  {
                    id: 'home',
                    label: 'Go to Home',
                    keywords: 'dashboard overview close session',
                    icon: <HomeIcon />,
                    run: goHome
                  }
                ]
              : []),
            ...(current || homeView.kind !== 'people'
              ? [
                  {
                    id: 'people',
                    label: 'Go to People',
                    keywords: 'voices speakers talk time contacts',
                    icon: <PeopleIcon />,
                    run: () => goPeople()
                  }
                ]
              : []),
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
                ]
              : []),
            {
              id: 'sidebar',
              label: sidebarShown || (drawer && drawerOpen) ? 'Hide sessions' : 'Show sessions',
              keywords: 'layout sessions list',
              shortcut: shortcutLabel('\\'),
              icon: <SidebarIcon />,
              run: toggleSidebar
            },
            ...PREFERENCE_PAGES.map((page) => ({
              id: `pref-${page.section}`,
              label: `Preferences: ${page.section}`,
              keywords: `settings preferences ${page.keywords}`,
              icon: <GearIcon />,
              run: () => openSettingsAt({ tab: page.tab, section: page.section })
            })),
            {
              id: 'toggle-system-audio',
              label: systemAudio ? 'Record the mic only' : 'Record the mic and computer audio',
              keywords: 'computer system audio calls meeting source input',
              icon: <SpeakerIcon />,
              run: () => void updateSettings({ captureSystemAudio: !systemAudio })
            },
            {
              id: 'toggle-density',
              label: density === 'compact' ? 'Use comfortable density' : 'Use compact density',
              keywords: 'density compact comfortable rows spacing appearance',
              icon: <GearIcon />,
              run: () => setDensity(density === 'compact' ? 'comfortable' : 'compact')
            },
            ...(settings
              ? [
                  {
                    id: 'toggle-semantic',
                    label: settings.semanticSearch ? 'Turn off search by meaning' : 'Turn on search by meaning',
                    keywords: 'semantic search meaning embeddings',
                    icon: <SearchIcon />,
                    run: () => void updateSettings({ semanticSearch: !settings.semanticSearch })
                  }
                ]
              : []),
            ...microphones.map((mic) => ({
              id: `mic-${mic.deviceId}`,
              label: `${settings?.micDeviceId === mic.deviceId ? 'Using' : 'Use'} microphone: ${shortDeviceName(mic.label)}`,
              keywords: 'microphone input device mic audio',
              icon: <MicIcon />,
              run: () => void updateSettings({ micDeviceId: mic.deviceId })
            })),
            ...people.map((person) => ({
              id: `person-${person.id}`,
              label: `Saved voice: ${person.name}${person.self ? ' (you)' : ''}`,
              keywords: 'person people speaker voice voiceprint',
              icon: <PeopleIcon />,
              run: () => openSettingsAt({ tab: 'people', section: 'Saved voices' })
            })),
            {
              id: 'settings',
              label: 'Preferences',
              keywords: 'preferences settings options',
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
          focus={settingsFocus}
        />
      ) : null}
    </div>
  )
}

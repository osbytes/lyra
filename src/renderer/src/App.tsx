import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageSummary, SessionKind, UpdateStatus, WhisperStatus } from '../../shared/types'
import { DictationDock } from './components/DictationDock'
import { Editor } from './components/Editor'
import { MeetingSpeakers } from './components/MeetingSpeakers'
import { CheckIcon, CopyIcon, PlusIcon } from './components/Icons'
import { SettingsDialog } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { useDictation } from './hooks/useDictation'
import { usePages } from './hooks/usePages'
import { useSettings } from './hooks/useSettings'
import { readingMinutes, relativeTime, wordCount } from './lib/format'
import { appendTranscript, promptFor } from './text/transcript'

/** The overlay pill doesn't need every audio frame; ~12 updates a second look smooth. */
const OVERLAY_FRAME_MS = 80

const MEETING_TITLE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

function toMarkdown(title: string, body: string): string {
  return title && title !== 'Untitled' ? `# ${title}\n\n${body}` : body
}

export default function App(): React.JSX.Element {
  const { pages, current, currentRef, saveState, edit, open, create, remove, flush } = usePages()
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
      const page = currentRef.current
      if (!page) return
      const view = scroller.current
      // Keep new words in view, unless the writer has scrolled up to reread.
      const follow = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 160
      edit({ body: appendTranscript(page.body, text) })
      if (follow) {
        requestAnimationFrame(() => view?.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }))
      }
    },
    [currentRef, edit]
  )

  const getContext = useCallback(() => {
    const page = currentRef.current
    return page ? promptFor(page.title, page.body) : ''
  }, [currentRef])

  const getDeviceId = useCallback(() => settingsRef.current?.micDeviceId ?? null, [])

  const dictation = useDictation({ getContext, onCommit, getDeviceId })
  const { recording, stop: stopDictation, start } = dictation

  /** Stops recording and writes the page to disk right away, so the file is complete. */
  const stop = useCallback(async () => {
    await stopDictation()
    await flush()
  }, [stopDictation, flush])

  const sessionKind = useRef<SessionKind>('dictation')

  /** Starts dictating into a new note named for this moment. */
  const startSession = useCallback(
    async (kind: SessionKind = 'dictation') => {
      await stop()
      sessionKind.current = kind
      const startedAt = new Date()
      const page = await create({ startedAt: startedAt.toISOString() })
      if (kind === 'meeting') {
        edit({ title: `Meeting · ${startedAt.toLocaleString(undefined, MEETING_TITLE_FORMAT)}` })
        await start({
          pageId: page.id,
          systemAudio: settingsRef.current?.captureSystemAudio ?? true
        })
      } else {
        await start()
      }
    },
    [stop, create, start, edit]
  )

  // Commands from the tray, the global hotkey, and the overlay pill.
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  useEffect(
    () =>
      window.api.onSessionCommand((command) => {
        if (command.type === 'stop' || recordingRef.current) void stop()
        else void startSession(command.kind)
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
      kind: sessionKind.current,
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

  const toggleDictation = useCallback(() => {
    if (recording) void stop()
    else if (currentRef.current) {
      sessionKind.current = 'dictation'
      void start()
    }
  }, [recording, stop, start, currentRef])

  const openPage = async (id: string): Promise<void> => {
    await stop()
    await open(id)
  }

  const newPage = useCallback(async () => {
    await stop()
    await create()
    requestAnimationFrame(() => titleInput.current?.select())
  }, [stop, create])

  const deletePage = async (page: PageSummary): Promise<void> => {
    if (!window.confirm(`Delete “${page.title || 'Untitled'}”? This cannot be undone.`)) return
    if (page.id === current?.id) await stop()
    await remove(page.id)
  }

  const copy = (): void => {
    if (!current?.body) return
    window.api.copyText(toMarkdown(current.title, current.body))
    setCopied(true)
  }

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 'd' && event.shiftKey) {
        event.preventDefault()
        toggleDictation()
      } else if (key === 'n' && event.shiftKey) {
        event.preventDefault()
        void startSession('dictation')
      } else if (key === 'n') {
        event.preventDefault()
        void newPage()
      } else if (key === ',') {
        event.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDictation, newPage, startSession])

  const words = current ? wordCount(current.body) : 0

  return (
    <div className={`app platform-${window.api.platform}`}>
      <Sidebar
        pages={pages}
        activeId={current?.id}
        update={update}
        onOpen={(id) => void openPage(id)}
        onCreate={() => void newPage()}
        onDelete={(page) => void deletePage(page)}
        onSettings={() => setShowSettings(true)}
      />

      <main className="workspace">
        <header className="topbar drag">
          {current ? (
            <>
              <span className="topbar-meta">
                {saveState === 'saving'
                  ? 'Saving…'
                  : `Saved ${relativeTime(current.updatedAt).toLowerCase()}`}
              </span>
              <button
                className="btn no-drag"
                type="button"
                onClick={copy}
                disabled={!current.body}
                title="Copy as Markdown"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? 'Copied' : 'Copy'}
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
          <>
            <div className="scroller" ref={scroller}>
              <article className="page">
                <input
                  ref={titleInput}
                  className="title-input"
                  value={current.title}
                  onChange={(event) => edit({ title: event.target.value })}
                  placeholder="Untitled"
                  aria-label="Page title"
                />
                <p className="page-stats">
                  {words} {words === 1 ? 'word' : 'words'}
                  {words > 0 ? ` · ${readingMinutes(words)} min read` : ''}
                </p>
                <MeetingSpeakers pageId={current.id} body={current.body} />
                <Editor
                  value={current.body}
                  ghost={dictation.live}
                  listening={dictation.phase === 'listening'}
                  onChange={(body) => edit({ body })}
                />
              </article>
            </div>
            {dictation.recording && sessionKind.current === 'meeting' && settings && !settings.meetingNoticeSeen ? (
              <div className="consent-banner" role="status">
                Recording this meeting. Make sure everyone is OK with being recorded.
                <button
                  className="btn"
                  type="button"
                  onClick={() => void updateSettings({ meetingNoticeSeen: true })}
                >
                  Got it
                </button>
              </div>
            ) : null}
            <DictationDock
              phase={dictation.phase}
              micName={dictation.micName}
              status={status}
              error={dictation.error}
              notice={dictation.notice}
              kind={sessionKind.current}
              micDeviceId={settings?.micDeviceId ?? null}
              onMicChange={(micDeviceId) => void updateSettings({ micDeviceId })}
              subscribeLevel={dictation.subscribeLevel}
              onToggle={toggleDictation}
            />
          </>
        ) : (
          <div className="empty">
            <h2>Talk your next post into existence</h2>
            <p>
              Create a page and start dictating. Everything is transcribed on this computer and
              saved as files in{' '}
              <code>{settings?.notesDir ?? 'your notes folder'}</code>. The first session
              downloads a ~150 MB speech model.
            </p>
            <button className="btn primary" type="button" onClick={() => void newPage()}>
              <PlusIcon />
              New page
            </button>
          </div>
        )}
      </main>

      {showSettings && settings ? (
        <SettingsDialog settings={settings} update={updateSettings} onClose={closeSettings} />
      ) : null}
    </div>
  )
}

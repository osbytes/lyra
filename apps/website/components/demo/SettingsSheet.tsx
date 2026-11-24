'use client'

// The parts of the app's Settings dialog the demo touches, in the app's settings markup.
import { useEffect, useRef, type ReactNode } from 'react'
import type { NotesEngine, Retention } from '@/lib/demo/types'
import { Segmented, Switch } from './Controls'
import { useDemo } from './DemoProvider'
import { CloseIcon } from './Icons'

const RETENTION: readonly { value: Retention; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'always', label: 'Always' }
]

const ENGINES: readonly { value: NotesEngine; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'On this computer' },
  { value: 'claude', label: 'With Claude' }
]

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  )
}

type Props = { onClose: () => void; newSessionShortcut: string }

export function SettingsSheet({ onClose, newSessionShortcut }: Props) {
  const { state, dispatch } = useDemo()
  const { settings } = state
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.querySelector('button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="demo-sheet" onMouseDown={onClose}>
      <div
        ref={panel}
        className="demo-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>
        <div className="settings-card">
          <Row label="Keep recordings" hint="Audio lets you replay and re-transcribe a session. Transcripts are always kept.">
            <Segmented
              label="Keep recordings"
              value={settings.retention}
              options={RETENTION}
              onChange={(retention) => dispatch({ type: 'settings', patch: { retention } })}
            />
          </Row>
          <Row label="Record computer audio" hint="The other side of calls. Speakers are labeled when there’s more than one.">
            <Switch
              label="Record computer audio"
              checked={settings.systemAudio}
              onChange={(systemAudio) => dispatch({ type: 'settings', patch: { systemAudio } })}
            />
          </Row>
          <Row label="Meeting notes" hint="Summary, decisions and action items after a call.">
            <Segmented
              label="Write notes after meetings"
              value={settings.notesEngine}
              options={ENGINES}
              onChange={(notesEngine) => dispatch({ type: 'settings', patch: { notesEngine } })}
            />
          </Row>
          {settings.notesEngine === 'local' ? (
            <p className="settings-notice">
              Runs a small model on this computer, so nothing leaves it. The first time downloads about 2 GB; long
              meetings can take a few minutes.
            </p>
          ) : null}
          {settings.notesEngine === 'claude' ? (
            <p className="settings-notice is-warning">
              Sends the meeting transcript to Anthropic’s API to write the notes. Audio and voiceprints stay on this
              computer. Uses your own API key and is billed to your account.
            </p>
          ) : null}
          <Row label="New session from anywhere" hint="Works while Lyra sits in the tray.">
            <kbd>{newSessionShortcut}</kbd>
          </Row>
          <Row label="Notes folder" hint="Plain text files you own.">
            <code className="settings-path">~/.lyra</code>
          </Row>
        </div>
      </div>
    </div>
  )
}

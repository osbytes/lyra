import { useEffect, useState, type ReactNode } from 'react'
import type { HotkeyAction, HotkeyStatus, Settings as SettingsValue } from '../../../shared/types'
import { HotkeyInput } from './HotkeyInput'
import { CloseIcon, FolderIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'

type Props = {
  settings: SettingsValue
  update: (patch: Partial<SettingsValue>) => Promise<SettingsValue>
  onClose: () => void
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

function NotesSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const [notice, setNotice] = useState<string | null>(null)

  const changeFolder = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (!picked || picked === settings.notesDir) return
    const previous = settings.notesDir
    await update({ notesDir: picked })
    if (window.confirm(`Move your existing notes from\n${previous}\ninto\n${picked}?`)) {
      const { moved, skipped } = await window.api.moveNotes(previous)
      setNotice(
        `Moved ${moved} ${moved === 1 ? 'note' : 'notes'}` +
          (skipped ? ` · ${skipped} skipped (same name already there)` : '')
      )
    } else {
      setNotice('Existing notes were left where they were.')
    }
  }

  return (
    <Section title="Notes">
      <Row label="Notes folder" hint="Every note is a file in this folder.">
        <code className="settings-path" title={settings.notesDir}>
          {settings.notesDir}
        </code>
        <div className="settings-buttons">
          <button className="btn" type="button" onClick={() => void changeFolder()}>
            Change…
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void window.api.revealNotesFolder()}
            title="Open in file manager"
          >
            <FolderIcon />
            Open
          </button>
        </div>
      </Row>
      {notice ? <p className="settings-notice">{notice}</p> : null}
      <Row label="File format" hint="For new notes. Existing .txt and .md files keep working.">
        <select
          className="settings-select"
          value={settings.fileFormat}
          onChange={(event) =>
            void update({ fileFormat: event.target.value as SettingsValue['fileFormat'] })
          }
        >
          <option value="txt">Plain text (.txt)</option>
          <option value="md">Markdown (.md)</option>
        </select>
      </Row>
    </Section>
  )
}

const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  dictation: 'CommandOrControl+Shift+Space',
  meeting: 'CommandOrControl+Shift+M'
}
const HOTKEY_SETTING: Record<HotkeyAction, 'hotkey' | 'meetingHotkey'> = {
  dictation: 'hotkey',
  meeting: 'meetingHotkey'
}

function HotkeyRow({
  action,
  label,
  hint,
  settings,
  update,
  status
}: Pick<Props, 'settings' | 'update'> & {
  action: HotkeyAction
  label: string
  hint: string
  status: HotkeyStatus | undefined
}) {
  const key = HOTKEY_SETTING[action]
  const value = settings[key]
  const problem = status?.accelerator === value && !status.registered ? status.error : null
  return (
    <>
      <Row label={label} hint={hint}>
        <HotkeyInput value={value} onChange={(next) => void update({ [key]: next })} />
        {value !== DEFAULT_HOTKEYS[action] ? (
          <button
            className="btn"
            type="button"
            onClick={() => void update({ [key]: DEFAULT_HOTKEYS[action] })}
          >
            Reset
          </button>
        ) : null}
      </Row>
      {problem ? <p className="settings-notice is-error">{problem}</p> : null}
    </>
  )
}

function ShortcutsSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([])

  useEffect(() => {
    void window.api.getHotkeyStatus().then(setStatuses)
    return window.api.onHotkeyStatus(setStatuses)
  }, [])

  const statusOf = (action: HotkeyAction): HotkeyStatus | undefined =>
    statuses.find((status) => status.action === action)

  return (
    <Section title="Shortcuts">
      <HotkeyRow
        action="dictation"
        label="Start or stop dictation"
        hint="Works from any app, even when Lyra is hidden. Starts a new note."
        settings={settings}
        update={update}
        status={statusOf('dictation')}
      />
      <HotkeyRow
        action="meeting"
        label="Start or stop a meeting"
        hint="Records your mic and the computer's audio, then labels who said what."
        settings={settings}
        update={update}
        status={statusOf('meeting')}
      />
      <Row label="Open at login" hint="Keeps the shortcuts available after a restart.">
        <input
          type="checkbox"
          className="settings-toggle"
          checked={settings.launchAtLogin}
          onChange={(event) => void update({ launchAtLogin: event.target.checked })}
          aria-label="Open Lyra at login"
        />
      </Row>
    </Section>
  )
}

function MeetingsSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  return (
    <Section title="Meetings">
      <Row
        label="Capture computer audio"
        hint="Records the other side of calls (Zoom, Meet, Teams). On macOS this needs Screen Recording permission."
      >
        <input
          type="checkbox"
          className="settings-toggle"
          checked={settings.captureSystemAudio}
          onChange={(event) => void update({ captureSystemAudio: event.target.checked })}
          aria-label="Capture computer audio in meetings"
        />
      </Row>
      <Row
        label="Keep meeting audio"
        hint="Otherwise the recording is deleted once the transcript is labeled."
      >
        <input
          type="checkbox"
          className="settings-toggle"
          checked={settings.keepMeetingAudio}
          onChange={(event) => void update({ keepMeetingAudio: event.target.checked })}
          aria-label="Keep meeting audio"
        />
      </Row>
    </Section>
  )
}

function PromptsSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const { enabled, ignoredApps } = settings.micPrompt
  const setPrompt = (patch: Partial<SettingsValue['micPrompt']>): void => {
    void update({ micPrompt: { ...settings.micPrompt, ...patch } })
  }
  return (
    <Section title="Prompts">
      <Row
        label="Offer to record when the mic turns on"
        hint="When another app (Zoom, Teams, …) starts using your microphone, ask whether to start a note."
      >
        <input
          type="checkbox"
          className="settings-toggle"
          checked={enabled}
          onChange={(event) => {
            setPrompt({ enabled: event.target.checked })
          }}
          aria-label="Offer to record when the mic turns on"
        />
      </Row>
      {ignoredApps.length ? (
        <Row label="Never ask for" hint="Apps you chose “Don’t ask” for.">
          <ul className="settings-chips">
            {ignoredApps.map((name) => (
              <li key={name}>
                {name}
                <button
                  type="button"
                  aria-label={`Ask again for ${name}`}
                  onClick={() => {
                    setPrompt({ ignoredApps: ignoredApps.filter((entry) => entry !== name) })
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
    </Section>
  )
}

export function SettingsDialog({ settings, update, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>
        <div className="modal-body">
          <NotesSection settings={settings} update={update} />
          <Section title="Microphone">
            <Row label="Input device" hint="Used for dictation and meetings.">
              <MicrophoneSelect
                value={settings.micDeviceId}
                onChange={(micDeviceId) => void update({ micDeviceId })}
              />
            </Row>
          </Section>
          <ShortcutsSection settings={settings} update={update} />
          <MeetingsSection settings={settings} update={update} />
          <PromptsSection settings={settings} update={update} />
        </div>
      </div>
    </div>
  )
}

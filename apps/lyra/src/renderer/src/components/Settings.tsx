import { useEffect, useState, type ReactNode } from 'react'
import type { HotkeyAction, HotkeyStatus, Settings as SettingsValue } from '../../../shared/types'
import { homePath } from '../lib/format'
import { Segmented, Switch } from './Controls'
import { HotkeyInput } from './HotkeyInput'
import { CloseIcon, FolderIcon, GearIcon, MicSmallIcon, PeopleIcon, RecordIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'
import { PeopleSettings } from './People'

type Props = {
  settings: SettingsValue
  update: (patch: Partial<SettingsValue>) => Promise<SettingsValue>
  onClose: () => void
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
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
          {homePath(settings.notesDir)}
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
        <Segmented
          label="File format"
          value={settings.fileFormat}
          options={FILE_FORMATS}
          onChange={(fileFormat) => void update({ fileFormat })}
        />
      </Row>
    </Section>
  )
}

const FILE_FORMATS = [
  { value: 'txt', label: 'Plain text' },
  { value: 'md', label: 'Markdown' }
] as const

const NOTES_ENGINES = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'On this computer' },
  { value: 'claude', label: 'With Claude' }
] as const

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
        <Switch
          label="Open Lyra at login"
          checked={settings.launchAtLogin}
          onChange={(launchAtLogin) => void update({ launchAtLogin })}
        />
      </Row>
    </Section>
  )
}

const RETENTION_CHOICES = [
  { value: '0', label: 'Until transcribed' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'forever', label: 'Forever' }
] as const

function retentionValue(days: number | null): string {
  return days === null ? 'forever' : String(days)
}

/** The choices, plus the stored value if it isn't one of them (settings.json edited by hand). */
function retentionChoices(days: number | null): { value: string; label: string }[] {
  const value = retentionValue(days)
  const known = RETENTION_CHOICES.some((choice) => choice.value === value)
  return known ? [...RETENTION_CHOICES] : [...RETENTION_CHOICES, { value, label: `${value} days` }]
}

function parseRetention(value: string): number | null {
  if (value === 'forever') return null
  const days = Number(value)
  return Number.isInteger(days) && days >= 0 ? days : 30
}

function MeetingsSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  return (
    <Section title="Meetings">
      <Row
        label="Capture computer audio"
        hint="Records the other side of calls (Zoom, Meet, Teams). On macOS this needs Screen Recording permission."
      >
        <Switch
          label="Capture computer audio in meetings"
          checked={settings.captureSystemAudio}
          onChange={(captureSystemAudio) => void update({ captureSystemAudio })}
        />
      </Row>
      <p className="settings-notice">
        Recording other people usually requires their consent. Meeting audio, transcripts, and
        voiceprints stay on this computer.
      </p>
      <Row
        label="Keep recordings"
        hint="Audio lets you replay and re-transcribe a session. Transcripts are always kept."
      >
        <select
          className="settings-select"
          aria-label="Keep recordings"
          value={retentionValue(settings.audioRetentionDays)}
          onChange={(event) => {
            void update({ audioRetentionDays: parseRetention(event.target.value) })
          }}
        >
          {retentionChoices(settings.audioRetentionDays).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  )
}

function MeetingNotesSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.hasClaudeKey().then(setHasKey)
  }, [])

  const saveKey = async (value: string | null): Promise<void> => {
    setError(null)
    try {
      await window.api.setClaudeKey(value)
      setHasKey(value !== null)
      setKey('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the key')
    }
  }

  return (
    <Section title="Meeting notes">
      <Row label="Write notes after meetings" hint="A summary, decisions, action items, and open questions at the top of the note.">
        <Segmented
          label="Write notes after meetings"
          value={settings.notesEngine}
          options={NOTES_ENGINES}
          onChange={(notesEngine) => void update({ notesEngine })}
        />
      </Row>
      {settings.notesEngine === 'local' ? (
        <p className="settings-notice">
          Runs a small model on this computer — nothing leaves it. The first time downloads about
          2 GB; long meetings can take a few minutes.
        </p>
      ) : null}
      {settings.notesEngine === 'claude' ? (
        <>
          <p className="settings-notice is-warning">
            Sends the meeting transcript to Anthropic’s API to write the notes. Audio and voiceprints
            stay on this computer. Uses your own API key and is billed to your account.
          </p>
          <Row label="Claude API key" hint={hasKey ? 'Saved in your system keychain.' : 'From console.anthropic.com.'}>
            {hasKey ? (
              <button className="btn" type="button" onClick={() => void saveKey(null)}>
                Remove key
              </button>
            ) : (
              <>
                <input
                  className="settings-input"
                  type="password"
                  value={key}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  onChange={(event) => {
                    setKey(event.target.value)
                  }}
                  aria-label="Claude API key"
                />
                <button
                  className="btn"
                  type="button"
                  disabled={!key.trim()}
                  onClick={() => void saveKey(key)}
                >
                  Save
                </button>
              </>
            )}
          </Row>
          {error ? <p className="settings-notice is-error">{error}</p> : null}
        </>
      ) : null}
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
        <Switch
          label="Offer to record when the mic turns on"
          checked={enabled}
          onChange={(next) => {
            setPrompt({ enabled: next })
          }}
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

const TABS = [
  { id: 'general', label: 'General', icon: <GearIcon /> },
  { id: 'recording', label: 'Recording', icon: <MicSmallIcon /> },
  { id: 'meetings', label: 'Meetings', icon: <RecordIcon /> },
  { id: 'people', label: 'People', icon: <PeopleIcon /> }
] as const

type TabId = (typeof TABS)[number]['id']

export function SettingsDialog({ settings, update, onClose }: Props) {
  const [tab, setTab] = useState<TabId>('general')
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]

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
        <nav className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={entry.id === tab ? 'page' : undefined}
              onClick={() => {
                setTab(entry.id)
              }}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <header className="modal-header">
            <h2>{active.label}</h2>
            <button className="icon-btn" type="button" onClick={onClose} aria-label="Close settings">
              <CloseIcon />
            </button>
          </header>
          <div className="modal-body">
            {tab === 'general' ? (
              <>
                <NotesSection settings={settings} update={update} />
                <Section title="Microphone">
                  <Row label="Input device" hint="Used for dictation and meetings.">
                    <MicrophoneSelect
                      value={settings.micDeviceId}
                      onChange={(micDeviceId) => void update({ micDeviceId })}
                    />
                  </Row>
                </Section>
              </>
            ) : null}
            {tab === 'recording' ? (
              <>
                <ShortcutsSection settings={settings} update={update} />
                <PromptsSection settings={settings} update={update} />
              </>
            ) : null}
            {tab === 'meetings' ? (
              <>
                <MeetingsSection settings={settings} update={update} />
                <MeetingNotesSection settings={settings} update={update} />
              </>
            ) : null}
            {tab === 'people' ? (
              <Section title="Saved voices">
                <PeopleSettings micDeviceId={settings.micDeviceId} />
              </Section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

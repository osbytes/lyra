import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PROVIDERS, ProviderId, type KeySource } from '../../../shared/ai'
import type { ProcessUsage, Settings as SettingsValue } from '../../../shared/types'
import { useAppUsage } from '../hooks/useAppUsage'
import {
  keyChanged,
  hotkeyProblem,
  useHotkeyStatus,
  type SettingsIssue,
  type SettingsTab
} from '../hooks/useSettingsIssues'
import { homePath } from '../lib/format'
import { record } from '../lib/history'
import { ConfirmDialog } from './ConfirmDialog'
import { ScrollArea, Segmented, Select, Switch } from './Controls'
import { HotkeyInput } from './HotkeyInput'
import { CloseIcon, FolderIcon, GaugeIcon, GearIcon, PeopleIcon, RecordIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'
import { PeopleSettings } from './People'
import { tip } from './Tooltip'
import { UsageChart } from './UsageChart'

type Update = (patch: Partial<SettingsValue>) => Promise<SettingsValue>

type Props = {
  settings: SettingsValue
  update: Update
  issues: SettingsIssue[]
  onClose: () => void
}

type SectionProps = Pick<Props, 'settings' | 'update'>

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

/** What Ctrl+Z says it undid, per setting. */
const CHANGE_LABELS: Partial<Record<keyof SettingsValue, string>> = {
  fileFormat: 'Changed the file format',
  micDeviceId: 'Changed the microphone',
  hotkey: 'Changed the session shortcut',
  launchAtLogin: 'Changed open at login',
  captureSystemAudio: 'Changed computer audio capture',
  audioRetentionDays: 'Changed how long audio is kept',
  notesEngine: 'Changed session summaries',
  cloudProvider: 'Changed the summary provider',
  cloudModel: 'Changed the summary model',
  cloudBaseUrl: 'Changed the server address',
  semanticSearch: 'Changed search by meaning',
  micPrompt: 'Changed the microphone prompt'
}

/** `update`, recorded so Ctrl+Z (and Ctrl+Shift+Z) can take the change back. */
function useUndoableUpdate(settings: SettingsValue, update: Update): Update {
  const current = useRef(settings)
  current.current = settings
  return useCallback(
    async (patch) => {
      const keys = Object.keys(patch) as (keyof SettingsValue)[]
      const before: Partial<SettingsValue> = {}
      for (const key of keys) Object.assign(before, { [key]: current.current[key] })
      const next = await update(patch)
      const [first] = keys
      record({
        label: (first && CHANGE_LABELS[first]) ?? 'Changed a setting',
        quiet: true,
        run: () => void update(patch),
        undo: () => void update(before)
      })
      return next
    },
    [update]
  )
}

const FILE_FORMATS = [
  { value: 'txt', label: 'Plain text' },
  { value: 'md', label: 'Markdown' }
] as const

function StorageSection({ settings, update }: SectionProps) {
  const [notice, setNotice] = useState<string | null>(null)
  const [moveFrom, setMoveFrom] = useState<{ from: string; to: string } | null>(null)

  const changeFolder = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (!picked || picked === settings.notesDir) return
    const previous = settings.notesDir
    await update({ notesDir: picked })
    setMoveFrom({ from: previous, to: picked })
  }

  const move = async (from: string): Promise<void> => {
    setMoveFrom(null)
    const { moved, skipped } = await window.api.moveNotes(from)
    setNotice(
      `Moved ${String(moved)} ${moved === 1 ? 'session' : 'sessions'}` +
        (skipped ? ` · ${String(skipped)} skipped (same name already there)` : '')
    )
  }

  return (
    <Section title="Storage">
      <Row label="Sessions folder" hint={homePath(settings.notesDir)}>
        <div className="settings-buttons">
          <button className="btn" type="button" onClick={() => void changeFolder()}>
            Change…
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void window.api.revealNotesFolder()}
            {...tip('Open in file manager')}
          >
            <FolderIcon />
            Open
          </button>
        </div>
      </Row>
      {notice ? <p className="settings-notice">{notice}</p> : null}
      <Row label="File format" hint="For new sessions. Existing .txt and .md files keep working.">
        <Segmented
          label="File format"
          value={settings.fileFormat}
          options={FILE_FORMATS}
          onChange={(fileFormat) => void update({ fileFormat })}
        />
      </Row>
      {moveFrom ? (
        <ConfirmDialog
          title="Move your existing sessions?"
          confirm="Move sessions"
          onConfirm={() => void move(moveFrom.from)}
          onCancel={() => {
            setMoveFrom(null)
            setNotice('Existing sessions were left where they were.')
          }}
        >
          From <code>{homePath(moveFrom.from)}</code> into <code>{homePath(moveFrom.to)}</code>.
          Sessions left behind won’t show in Lyra.
        </ConfirmDialog>
      ) : null}
    </Section>
  )
}

const SUMMARY_ENGINES = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'On this computer' },
  { value: 'cloud', label: 'Cloud model' }
] as const

const PROVIDER_OPTIONS = ProviderId.options.map((id) => ({ value: id, label: PROVIDERS[id].label }))

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

function StartupSection({ settings, update }: SectionProps) {
  const statuses = useHotkeyStatus()
  const problem = hotkeyProblem(settings, statuses)
  return (
    <Section title="Shortcut and startup">
      <div className={problem ? 'settings-group has-issue' : 'settings-group'}>
        <Row
          label="Start or stop a session"
          hint="Works from any app, even when Lyra is hidden."
        >
          <HotkeyInput value={settings.hotkey} onChange={(hotkey) => void update({ hotkey })} />
          {settings.hotkey !== DEFAULT_HOTKEY ? (
            <button className="btn" type="button" onClick={() => void update({ hotkey: DEFAULT_HOTKEY })}>
              Reset
            </button>
          ) : null}
        </Row>
        {problem ? (
          <p className="settings-issue" role="alert">
            <span className="issue-dot" aria-hidden="true" />
            {problem} Pick another shortcut.
          </p>
        ) : null}
      </div>
      <Row label="Open at login" hint="Keeps the shortcut available after a restart.">
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

function RecordingSection({ settings, update }: SectionProps) {
  return (
    <Section title="Recording">
      <Row
        label="Capture computer audio"
        hint="Records the other side of calls (Zoom, Meet, Teams). On macOS this needs Screen Recording permission."
      >
        <Switch
          label="Capture computer audio"
          checked={settings.captureSystemAudio}
          onChange={(captureSystemAudio) => void update({ captureSystemAudio })}
        />
      </Row>
      <p className="settings-notice is-footnote">
        Recording other people usually requires their consent. Session audio, transcripts and
        voiceprints stay on this computer.
      </p>
      <Row
        label="Keep audio"
        hint="Audio lets you replay and re-transcribe a session. Transcripts are always kept."
      >
        <Select
          label="Keep audio"
          value={retentionValue(settings.audioRetentionDays)}
          options={retentionChoices(settings.audioRetentionDays)}
          onChange={(value) => {
            void update({ audioRetentionDays: parseRetention(value) })
          }}
        />
      </Row>
    </Section>
  )
}

/** A text setting saved when the field loses focus or on Enter, not on every keystroke. */
function CommitInput({
  value,
  placeholder,
  label,
  onCommit
}: {
  value: string | null
  placeholder: string
  label: string
  /** Resolves to what was saved: a value the settings schema rejects is not kept. */
  onCommit: (next: string | null) => Promise<string | null>
}) {
  const [text, setText] = useState(value ?? '')
  // Undo, or another window, can change the saved value under the field.
  useEffect(() => {
    setText(value ?? '')
  }, [value])
  const commit = (): void => {
    const trimmed = text.trim()
    const next = trimmed ? trimmed : null
    if (next === value) return
    void onCommit(next).then((saved) => {
      setText(saved ?? '')
    })
  }
  return (
    <input
      className="settings-input"
      value={text}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      aria-label={label}
    />
  )
}

function SummarySection({ settings, update }: SectionProps) {
  const provider = settings.cloudProvider
  const info = PROVIDERS[provider]
  const [keySource, setKeySource] = useState<KeySource | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void window.api.keySource(provider).then((source) => {
      if (current) setKeySource(source)
    })
    return () => {
      current = false
    }
  }, [provider])

  const saveKey = async (value: string | null): Promise<void> => {
    setError(null)
    try {
      await window.api.setKey(provider, value)
      // Removing a saved key can fall back to the environment, so ask rather than assume.
      setKeySource(await window.api.keySource(provider))
      setKey('')
      keyChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the key')
    }
  }

  const missingKey = settings.notesEngine === 'cloud' && info.needsKey && keySource === null
  const keyHint =
    keySource === 'keychain'
      ? 'Saved in your system keychain.'
      : keySource === 'environment'
        ? `From ${info.keyEnv ?? 'the environment'}. A key saved here is used instead.`
        : info.keyHelp
  const destination =
    provider === 'openai-compatible'
      ? `the server at ${settings.cloudBaseUrl ?? 'the address below'}`
      : `${info.label}’s API`

  return (
    <Section title="Summaries">
      <Row
        label="Summarize sessions"
        hint="A summary, decisions, action items and open questions above your notes."
      >
        <Segmented
          label="Summarize sessions"
          value={settings.notesEngine}
          options={SUMMARY_ENGINES}
          onChange={(notesEngine) => void update({ notesEngine })}
        />
      </Row>
      {settings.notesEngine === 'local' ? (
        <p className="settings-notice">
          Runs a small model on this computer, so nothing leaves it. The first time downloads about
          2 GB; long sessions can take a few minutes.
        </p>
      ) : null}
      {settings.notesEngine === 'cloud' ? (
        <>
          <p className="settings-notice is-warning">
            Sends the session’s transcript to {destination} to write the summary. Audio and
            voiceprints stay on this computer.
            {info.needsKey ? ' Uses your own API key and is billed to your account.' : ''}
          </p>
          <Row label="Provider" hint="Any of these, through one interface; switch whenever you like.">
            <Select
              label="Provider"
              value={provider}
              options={PROVIDER_OPTIONS}
              onChange={(cloudProvider) => {
                // Model ids don't carry over between providers.
                void update({ cloudProvider, cloudModel: null })
              }}
            />
          </Row>
          <Row
            label="Model"
            hint={
              info.defaultModel
                ? `Leave empty for ${info.defaultModel}.`
                : 'The model id, as the provider names it.'
            }
          >
            <CommitInput
              label="Model"
              value={settings.cloudModel}
              placeholder={info.defaultModel ?? 'model id'}
              onCommit={(cloudModel) => update({ cloudModel }).then((saved) => saved.cloudModel)}
            />
          </Row>
          {info.needsBaseUrl ? (
            <Row label="Server address" hint="Ollama, LM Studio, llama.cpp or any OpenAI-compatible API.">
              <CommitInput
                label="Server address"
                value={settings.cloudBaseUrl}
                placeholder="http://localhost:11434/v1"
                onCommit={(cloudBaseUrl) => update({ cloudBaseUrl }).then((saved) => saved.cloudBaseUrl)}
              />
            </Row>
          ) : null}
          <div className={missingKey ? 'settings-group has-issue' : 'settings-group'}>
            <Row label="API key" hint={keyHint}>
              {keySource === 'keychain' ? (
                <button className="btn" type="button" onClick={() => void saveKey(null)}>
                  Remove key
                </button>
              ) : (
                <>
                  <input
                    className="settings-input"
                    type="password"
                    value={key}
                    autoComplete="off"
                    onChange={(event) => {
                      setKey(event.target.value)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && key.trim()) void saveKey(key)
                    }}
                    aria-label={`${info.label} API key`}
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
            {missingKey ? (
              <p className="settings-issue" role="alert">
                <span className="issue-dot" aria-hidden="true" />
                Summaries won’t run until you add a key.
              </p>
            ) : null}
          </div>
          {error ? <p className="settings-notice is-error">{error}</p> : null}
        </>
      ) : null}
    </Section>
  )
}

function SearchSection({ settings, update }: SectionProps) {
  return (
    <Section title="Search">
      <Row
        label="Search by meaning"
        hint="Also finds sessions that say the same thing in other words: “car repairs” finds “new tires and an oil change”."
      >
        <Switch
          label="Search by meaning"
          checked={settings.semanticSearch}
          onChange={(semanticSearch) => void update({ semanticSearch })}
        />
      </Row>
      {settings.semanticSearch ? (
        <p className="settings-notice">
          Runs a small model on this computer, so nothing leaves it. The first time downloads about
          150 MB, then reads through your sessions in the background.
        </p>
      ) : null}
    </Section>
  )
}

function PromptsSection({ settings, update }: SectionProps) {
  const { enabled, ignoredApps } = settings.micPrompt
  const setPrompt = (patch: Partial<SettingsValue['micPrompt']>): void => {
    void update({ micPrompt: { ...settings.micPrompt, ...patch } })
  }
  return (
    <Section title="Prompts">
      <Row
        label="Offer a session when the mic turns on"
        hint="When another app (Zoom, Teams, …) starts using your microphone, ask whether to start a session."
      >
        <Switch
          label="Offer a session when the mic turns on"
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
                  {...tip('Ask again')}
                  onClick={() => {
                    setPrompt({ ignoredApps: ignoredApps.filter((entry) => entry !== name) })
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
    </Section>
  )
}

const PROCESS_LABELS: Record<ProcessUsage['kind'], { label: string; hint: string }> = {
  main: { label: 'Lyra', hint: 'Files, recording and Whisper transcription.' },
  windows: { label: 'Windows', hint: 'The main window and the recording overlay.' },
  speakers: { label: 'Speaker detection', hint: 'Tells voices apart in sessions.' },
  notes: { label: 'Local summaries', hint: 'The on-device model that writes session notes.' },
  search: { label: 'Search index', hint: 'Keeps search up to date as sessions change.' },
  graphics: { label: 'Graphics', hint: 'Drawing the interface.' },
  other: { label: 'Other', hint: 'Chromium’s network, audio and other helper processes.' }
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(Math.round(mb))} MB`
}

function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : String(Math.round(percent))}%`
}

type Figures = Pick<ProcessUsage, 'cpuPercent' | 'memoryBytes'>

function UsageFigures({ cpuPercent, memoryBytes }: Figures) {
  return (
    <span className="settings-usage">
      <span>{formatCpu(cpuPercent)} CPU</span>
      <span>{formatBytes(memoryBytes)}</span>
    </span>
  )
}

function PerformanceSection() {
  const usage = useAppUsage()
  const latest = usage?.samples.at(-1)
  if (!usage || !latest) {
    return (
      <Section title="Resource use">
        <p className="settings-notice">Measuring…</p>
      </Section>
    )
  }
  const memoryShare = (latest.memoryBytes / usage.totalMemoryBytes) * 100
  // Each process's busiest moment in the window, so a spike that has passed still shows its owner.
  const peakCpu = (kind: ProcessUsage['kind']): number =>
    Math.max(
      0,
      ...usage.samples.map(
        (sample) => sample.processes.find((entry) => entry.kind === kind)?.cpuPercent ?? 0
      )
    )
  return (
    <>
      <Section title="Last 30 minutes">
        <UsageChart
          title="CPU"
          samples={usage.samples}
          intervalMs={usage.intervalMs}
          value={(sample) => sample.cpuPercent}
          format={formatCpu}
          floor={5}
        />
        <UsageChart
          title="Memory"
          samples={usage.samples}
          intervalMs={usage.intervalMs}
          value={(sample) => sample.memoryBytes}
          format={formatBytes}
          floor={1024 ** 3}
          unit={1024 ** 3}
        />
        <p className="settings-notice">
          Now: {formatCpu(latest.cpuPercent)} of this computer’s CPU and{' '}
          {formatBytes(latest.memoryBytes)} ({memoryShare.toFixed(1)}% of{' '}
          {formatBytes(usage.totalMemoryBytes)}) memory. Measured every{' '}
          {String(usage.intervalMs / 1000)} seconds since Lyra started.
        </p>
      </Section>
      <Section title="By process">
        {latest.processes.map((entry) => {
          const peak = peakCpu(entry.kind)
          const { label, hint } = PROCESS_LABELS[entry.kind]
          return (
            <Row
              key={entry.kind}
              label={label}
              hint={peak >= 1 ? `${hint} Peak ${formatCpu(peak)} CPU.` : hint}
            >
              <UsageFigures cpuPercent={entry.cpuPercent} memoryBytes={entry.memoryBytes} />
            </Row>
          )
        })}
        <p className="settings-notice">
          CPU is a share of the whole computer. Speaker detection and local summaries only run
          while they have work, so they come and go.
        </p>
      </Section>
    </>
  )
}

const TABS: readonly { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <GearIcon /> },
  { id: 'sessions', label: 'Sessions', icon: <RecordIcon /> },
  { id: 'people', label: 'People', icon: <PeopleIcon /> },
  { id: 'performance', label: 'Performance', icon: <GaugeIcon /> }
]

export function SettingsDialog({ settings, update: rawUpdate, issues, onClose }: Props) {
  // Open on the tab with a problem, so the badge that brought the user here leads somewhere.
  const [tab, setTab] = useState<SettingsTab>(() => issues[0]?.tab ?? 'general')
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]
  const update = useUndoableUpdate(settings, rawUpdate)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
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
          {TABS.map((entry) => {
            const flagged = issues.some((issue) => issue.tab === entry.id)
            return (
              <button
                key={entry.id}
                type="button"
                aria-current={entry.id === tab ? 'page' : undefined}
                aria-label={flagged ? `${entry.label} (needs attention)` : undefined}
                onClick={() => {
                  setTab(entry.id)
                }}
              >
                {entry.icon}
                {entry.label}
                {flagged ? <span className="issue-dot nav-issue" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </nav>
        <div className="settings-main">
          <header className="modal-header">
            <h2>{active?.label}</h2>
            <button
              className="icon-btn"
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              {...tip('Close', 'Esc')}
            >
              <CloseIcon />
            </button>
          </header>
          <ScrollArea className="modal-body">
            {tab === 'general' ? (
              <>
                <StorageSection settings={settings} update={rawUpdate} />
                <Section title="Microphone">
                  <Row label="Input device" hint="Used for every session.">
                    <MicrophoneSelect
                      value={settings.micDeviceId}
                      onChange={(micDeviceId) => void update({ micDeviceId })}
                    />
                  </Row>
                </Section>
                <StartupSection settings={settings} update={update} />
              </>
            ) : null}
            {tab === 'sessions' ? (
              <>
                <RecordingSection settings={settings} update={update} />
                <SummarySection settings={settings} update={update} />
                <SearchSection settings={settings} update={update} />
                <PromptsSection settings={settings} update={update} />
              </>
            ) : null}
            {tab === 'people' ? (
              <Section title="Saved voices">
                <PeopleSettings micDeviceId={settings.micDeviceId} />
              </Section>
            ) : null}
            {tab === 'performance' ? <PerformanceSection /> : null}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

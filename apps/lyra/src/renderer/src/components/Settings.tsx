import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PROVIDERS, ProviderId, type KeySource } from '../../../shared/ai'
import { formatBytes } from '../../../shared/bytes'
import { WHISPER_LANGUAGES } from '../../../shared/languages'
import { mergeIgnoredApps } from '../../../shared/ignoredApps'
import { isStricterRetention } from '../../../shared/retention'
import type {
  NotesBackfill,
  NotesBackfillKind,
  NotesBackfillResult,
  NotesTestResult,
  ProcessUsage,
  Settings as SettingsValue
} from '../../../shared/types'
import { useAppUsage } from '../hooks/useAppUsage'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { usePermissions } from '../hooks/usePermissions'
import {
  keyChanged,
  hotkeyProblem,
  useHotkeyStatus,
  type SettingsIssue,
  type SettingsTab
} from '../hooks/useSettingsIssues'
import { homePath } from '../lib/format'
import { record } from '../lib/history'
import { ipcErrorMessage } from '../lib/ipcError'
import { hostedPrivacy } from '../lib/summaryPrivacy'
import { AboutSettings, InfoIcon } from './About'
import { ConfirmDialog } from './ConfirmDialog'
import { ScrollArea, Segmented, Select, Switch } from './Controls'
import { HotkeyInput } from './HotkeyInput'
import { CloseIcon, FolderIcon, GaugeIcon, GearIcon, PeopleIcon, RecordIcon } from './Icons'
import { LocalServerSettings, TestResult } from './LocalServer'
import { MicrophoneSelect } from './MicrophoneSelect'
import { PeopleSettings } from './People'
import { PermissionRow } from './Permissions'
import { CommitInput, Row, Section, type SectionProps, type Update } from './SettingsParts'
import { tip } from './Tooltip'
import { UsageChart } from './UsageChart'
import { VocabularyEditor } from './Vocabulary'

type Props = {
  settings: SettingsValue
  update: Update
  issues: SettingsIssue[]
  onClose: () => void
}

/** What Ctrl+Z says it undid, per setting. */
const CHANGE_LABELS: Partial<Record<keyof SettingsValue, string>> = {
  fileFormat: 'Changed the file format',
  micDeviceId: 'Changed the microphone',
  hotkey: 'Changed the session shortcut',
  launchAtLogin: 'Changed open at login',
  captureSystemAudio: 'Changed computer audio capture',
  transcriptionLanguage: 'Changed the transcription language',
  notesEngine: 'Changed session summaries',
  cloudProvider: 'Changed the summary provider',
  cloudModel: 'Changed the summary model',
  cloudBaseUrl: 'Changed the server address',
  semanticSearch: 'Changed search by meaning',
  micPrompt: 'Changed the microphone prompt',
  meetingPrompt: 'Changed the meeting prompt',
  vocabulary: 'Changed names and terms'
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
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [moveFrom, setMoveFrom] = useState<{ from: string; to: string } | null>(null)
  const [busy, setBusy] = useState<'picking' | 'moving' | null>(null)

  const changeFolder = async (): Promise<void> => {
    const previous = settings.notesDir
    setNotice(null)
    setBusy('picking')
    try {
      // Main shows the picker and switches the folder itself; the new settings arrive here and
      // through the settings broadcast. It refuses while recording or identifying speakers.
      const next = await window.api.pickFolder()
      if (next && next.notesDir !== previous) setMoveFrom({ from: previous, to: next.notesDir })
    } catch (caught) {
      setNotice({ text: ipcErrorMessage(caught, 'Couldn’t change the sessions folder.'), error: true })
    } finally {
      setBusy(null)
    }
  }

  const move = async (from: string): Promise<void> => {
    setMoveFrom(null)
    setBusy('moving')
    setNotice({ text: 'Moving sessions…', error: false })
    try {
      // Main remembers the folder it switched from; it takes no path from this window.
      const { moved, skipped } = await window.api.moveNotes()
      setNotice({
        text:
          `Moved ${String(moved)} ${moved === 1 ? 'session' : 'sessions'}` +
          (skipped ? ` · ${String(skipped)} skipped (same name already there)` : ''),
        error: false
      })
    } catch (caught) {
      setNotice({
        text: `${ipcErrorMessage(caught, 'Couldn’t move the sessions.')} They’re still in ${homePath(from)}.`,
        error: true
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Storage">
      <Row label="Sessions folder" hint={homePath(settings.notesDir)}>
        <div className="settings-buttons">
          <button
            className="btn"
            type="button"
            disabled={busy !== null}
            onClick={() => void changeFolder()}
          >
            Change…
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              window.api.revealNotesFolder().catch((caught: unknown) => {
                setNotice({ text: ipcErrorMessage(caught, 'Couldn’t open the folder.'), error: true })
              })
            }}
            {...tip('Open in file manager')}
          >
            <FolderIcon />
            Open
          </button>
        </div>
      </Row>
      {notice ? (
        <p
          className={notice.error ? 'settings-notice is-error' : 'settings-notice'}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
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
          title="Move your sessions to the new folder?"
          confirm="Move sessions"
          onConfirm={() => void move(moveFrom.from)}
          onCancel={() => {
            const { from } = moveFrom
            setMoveFrom(null)
            setNotice({
              text: `Your sessions stayed in ${homePath(from)}. They won’t show in Lyra until you move them here or switch back to that folder.`,
              error: false
            })
          }}
        >
          Lyra now uses <code>{homePath(moveFrom.to)}</code>. Your existing sessions are still in{' '}
          <code>{homePath(moveFrom.from)}</code> and won’t show in Lyra until they’re moved here, or
          until you switch back to that folder. Cancel leaves them where they are.
        </ConfirmDialog>
      ) : null}
    </Section>
  )
}

/**
 * What writes summaries, as the user thinks of it. "Local server" isn't a stored engine: it is
 * the cloud engine with the OpenAI-compatible provider, so settings.json stays readable by older
 * builds. Only a native Ollama server on this computer counts as on-device (see writers.ts).
 */
type SummaryChoice = 'off' | 'local' | 'server' | 'cloud'

const SUMMARY_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'On this computer', hint: 'A built-in model; nothing leaves this computer' },
  { value: 'server', label: 'Local server', hint: 'Ollama, LM Studio, llama.cpp…' },
  { value: 'cloud', label: 'Cloud model', hint: 'Anthropic, OpenAI or Google, with your key' }
] as const

function summaryChoice(settings: SettingsValue): SummaryChoice {
  if (settings.notesEngine !== 'cloud') return settings.notesEngine
  return settings.cloudProvider === 'openai-compatible' ? 'server' : 'cloud'
}

/** The settings a choice stands for; a provider switch clears the model (ids don't carry over). */
function choicePatch(choice: SummaryChoice, settings: SettingsValue): Partial<SettingsValue> {
  switch (choice) {
    case 'off':
    case 'local':
      return { notesEngine: choice }
    case 'server':
      return settings.cloudProvider === 'openai-compatible'
        ? { notesEngine: 'cloud' }
        : { notesEngine: 'cloud', cloudProvider: 'openai-compatible', cloudModel: null }
    case 'cloud':
      return settings.cloudProvider === 'openai-compatible'
        ? { notesEngine: 'cloud', cloudProvider: 'anthropic', cloudModel: null }
        : { notesEngine: 'cloud' }
  }
}

/** Hosted providers only: a server the user runs has its own choice above. */
const PROVIDER_OPTIONS = ProviderId.options
  .filter((id) => id !== 'openai-compatible')
  .map((id) => ({ value: id, label: PROVIDERS[id].label }))

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
      <Row
        label="Open at login"
        hint="Starts in the tray, so the shortcut and meeting prompts work after a restart."
      >
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

/** Whisper's languages, named in the user's own language where the platform knows the name. */
function languageChoices(): { value: string; label: string }[] {
  const names = new Intl.DisplayNames(navigator.languages, { type: 'language', fallback: 'none' })
  const choices = WHISPER_LANGUAGES.map(({ code, name }) => ({ value: code, label: names.of(code) ?? name }))
  choices.sort((a, b) => a.label.localeCompare(b.label))
  return [{ value: 'auto', label: 'Detect automatically' }, ...choices]
}

/** The choice's name, for the confirmation ("Keep audio for 7 days"). */
function retentionLabel(days: number | null): string {
  const value = retentionValue(days)
  return RETENTION_CHOICES.find((choice) => choice.value === value)?.label ?? `${value} days`
}

type RetentionConfirm = { days: number | null; sessions: number; bytes: number }

/**
 * "Keep audio". A stricter value deletes recordings as soon as it is saved, so it is saved only
 * after the user confirms how many sessions lose their audio. Saved without undo: Ctrl+Z can't
 * bring deleted audio back, and redoing it would delete without asking.
 */
function RetentionRow({ settings, save }: { settings: SettingsValue; save: Update }) {
  const [confirm, setConfirm] = useState<RetentionConfirm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const choose = async (days: number | null): Promise<void> => {
    setError(null)
    if (!isStricterRetention(settings.audioRetentionDays, days)) {
      await save({ audioRetentionDays: days })
      return
    }
    setChecking(true)
    try {
      const preview = await window.api.previewRetention(days)
      if (preview.sessions > 0) setConfirm({ days, ...preview })
      else await save({ audioRetentionDays: days })
    } catch (caught) {
      setError(ipcErrorMessage(caught, 'Couldn’t check which recordings this would delete.'))
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <Row
        label="Keep audio"
        hint="Audio lets you replay and re-transcribe a session. Transcripts are always kept."
      >
        <Select
          label="Keep audio"
          value={retentionValue(settings.audioRetentionDays)}
          options={retentionChoices(settings.audioRetentionDays)}
          disabled={checking}
          onChange={(value) => {
            void choose(parseRetention(value)).catch((caught: unknown) => {
              setError(ipcErrorMessage(caught, 'Couldn’t change how long audio is kept.'))
            })
          }}
        />
      </Row>
      {error ? (
        <p className="settings-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`Delete the audio of ${String(confirm.sessions)} ${confirm.sessions === 1 ? 'session' : 'sessions'}?`}
          confirm="Delete audio"
          danger
          onConfirm={() => {
            const { days } = confirm
            setConfirm(null)
            save({ audioRetentionDays: days }).catch((caught: unknown) => {
              setError(ipcErrorMessage(caught, 'Couldn’t change how long audio is kept.'))
            })
          }}
          onCancel={() => {
            setConfirm(null)
          }}
        >
          Keeping audio for {retentionLabel(confirm.days).toLowerCase()} deletes the recordings of{' '}
          {confirm.sessions} {confirm.sessions === 1 ? 'session' : 'sessions'}
          {confirm.bytes > 0 ? ` (${formatBytes(confirm.bytes)})` : ''} now. Their transcripts and
          notes stay. Deleted audio can’t be brought back.
        </ConfirmDialog>
      ) : null}
    </>
  )
}

function RecordingSection({
  settings,
  update,
  saveRetention
}: SectionProps & { saveRetention: Update }) {
  const [languages] = useState(languageChoices)
  const permissions = usePermissions()
  const mac = window.api.platform === 'darwin'
  return (
    <Section title="Recording">
      <Row
        label="Language"
        hint="What you speak in sessions. Detecting it works on each short stretch of speech, so a set language is more reliable."
      >
        <Select
          label="Language"
          value={settings.transcriptionLanguage}
          options={languages}
          onChange={(transcriptionLanguage) => void update({ transcriptionLanguage })}
        />
      </Row>
      <VocabularyEditor settings={settings} update={update} />
      <Row
        label="Capture computer audio"
        hint={
          mac
            ? 'Records the other side of calls (Zoom, Meet, Teams). macOS asks for Screen Recording permission for this.'
            : 'Records the other side of calls (Zoom, Meet, Teams).'
        }
      >
        <Switch
          label="Capture computer audio"
          checked={settings.captureSystemAudio}
          onChange={(captureSystemAudio) => void update({ captureSystemAudio })}
        />
      </Row>
      {/* The runtime this model needs has no build for Intel Macs. */}
      {mac && window.api.arch === 'x64' ? null : (
        <Row
          label="Larger speaker model"
          hint="Tells people apart more reliably, most of all in a room with several people. A 121 MB download the first time, and labeling takes longer on slower computers."
        >
          <Switch
            label="Larger speaker model"
            checked={settings.largerSpeakerModel}
            onChange={(largerSpeakerModel) => void update({ largerSpeakerModel })}
          />
        </Row>
      )}
      <p className="settings-notice is-footnote">
        Recording other people usually requires their consent. Session audio, transcripts and
        voiceprints stay on this computer.
      </p>
      {settings.captureSystemAudio ? <PermissionRow kind="screen" status={permissions} /> : null}
      <RetentionRow settings={settings} save={saveRetention} />
    </Section>
  )
}

/** The API key row, for hosted providers and for a server that asks for one. */
function ApiKey({ settings }: Pick<SectionProps, 'settings'>) {
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
      setError(ipcErrorMessage(caught, 'Could not save the key'))
    }
  }

  const missingKey = info.needsKey && keySource === null
  const keyHint =
    keySource === 'keychain'
      ? 'Saved in your system keychain.'
      : keySource === 'environment'
        ? `From ${info.keyEnv ?? 'the environment'}. A key saved here is used instead.`
        : info.keyHelp

  return (
    <>
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
  )
}

/** "Test" for a hosted provider: one tiny request with Lyra's own sample text. */
function TestHosted() {
  const [state, setState] = useState<{ busy: boolean; result: NotesTestResult | null }>({
    busy: false,
    result: null
  })
  const run = async (): Promise<void> => {
    setState({ busy: true, result: null })
    try {
      setState({ busy: false, result: await window.api.testNotesWriter() })
    } catch (caught) {
      setState({ busy: false, result: { ok: false, error: ipcErrorMessage(caught) } })
    }
  }
  return (
    <>
      <Row label="Check the connection" hint="Sends a two-line sample (not your sessions) and asks for a title.">
        <button className="btn" type="button" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? 'Testing…' : 'Test'}
        </button>
      </Row>
      {state.result ? <TestResult result={state.result} /> : null}
    </>
  )
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

function backfillText(kind: NotesBackfillKind, result: NotesBackfillResult): string {
  const done = `${kind === 'outdated' ? 'Rewrote' : 'Wrote'} ${plural(result.written, 'summary', 'summaries')}`
  const failed = result.failed ? `; ${plural(result.failed, 'session', 'sessions')} failed (each one shows why)` : ''
  return `${result.stopped ? 'Stopped. ' : ''}${done}${failed}.`
}

/**
 * Notes for sessions recorded before the current notes pipeline, or before summaries were on.
 * Each session's notes record the pipeline that made them, so this finds the ones worth
 * redoing; a summary the user edited is never touched.
 */
function NotesBackfillRows() {
  const [status, setStatus] = useState<NotesBackfill | null>(null)
  const [busy, setBusy] = useState<NotesBackfillKind | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const refresh = useCallback(() => {
    window.api.notesBackfillStatus().then(setStatus, (caught: unknown) => {
      setNotice({ text: ipcErrorMessage(caught), error: true })
    })
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const run = async (kind: NotesBackfillKind): Promise<void> => {
    setBusy(kind)
    setNotice(null)
    try {
      const result = await window.api.backfillNotes(kind)
      setNotice({ text: backfillText(kind, result), error: result.failed > 0 })
    } catch (caught) {
      setNotice({ text: ipcErrorMessage(caught), error: true })
    } finally {
      setBusy(null)
      refresh()
    }
  }
  const button = (kind: NotesBackfillKind, label: string) =>
    busy === kind ? (
      <button className="btn" type="button" onClick={() => void window.api.stopBackfillNotes()}>
        Stop
      </button>
    ) : (
      <button className="btn" type="button" disabled={busy !== null || status?.running} onClick={() => void run(kind)}>
        {label}
      </button>
    )

  const edited = status?.edited ? ` ${plural(status.edited, 'summary', 'summaries')} you edited stay as they are.` : ''
  return (
    <>
      {status?.outdated || busy === 'outdated' ? (
        <Row
          label="Older summaries"
          hint={`${plural(status?.outdated ?? 0, 'summary was', 'summaries were')} written by an earlier version of Lyra. Rewriting gives them sections and better action items.${edited}`}
        >
          {button('outdated', 'Rewrite')}
        </Row>
      ) : null}
      {status?.missing || busy === 'missing' ? (
        <Row
          label="Meetings without a summary"
          hint={`${plural(status?.missing ?? 0, 'meeting has', 'meetings have')} no summary yet, from before summaries were on.`}
        >
          {button('missing', 'Write')}
        </Row>
      ) : null}
      {notice ? (
        <p className={notice.error ? 'settings-notice is-error' : 'settings-notice'} role="status">
          {notice.text}
        </p>
      ) : null}
    </>
  )
}

function SummarySection({ settings, update }: SectionProps) {
  const choice = summaryChoice(settings)
  const info = PROVIDERS[settings.cloudProvider]

  return (
    <Section title="Summaries">
      <Row
        label="Summarize sessions"
        hint="A summary, decisions, action items and open questions above your notes, and a suggested title."
      >
        <Select
          label="Summarize sessions"
          value={choice}
          options={SUMMARY_CHOICES}
          onChange={(next) => {
            if (next !== choice) void update(choicePatch(next, settings))
          }}
        />
      </Row>
      {choice === 'local' ? (
        <p className="settings-notice">
          Runs a small model on this computer, so nothing leaves it. The first time downloads about
          2 GB; long sessions can take a few minutes.
        </p>
      ) : null}
      {choice === 'server' ? (
        <>
          <LocalServerSettings settings={settings} update={update} />
          <ApiKey settings={settings} />
        </>
      ) : null}
      {choice === 'cloud' ? (
        <>
          <p className="settings-notice is-warning">{hostedPrivacy(info.label, info.needsKey)}</p>
          <Row label="Provider" hint="Any of these, through one interface; switch whenever you like.">
            <Select
              label="Provider"
              value={settings.cloudProvider}
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
          <ApiKey settings={settings} />
          <TestHosted />
        </>
      ) : null}
      {choice !== 'off' ? <NotesBackfillRows /> : null}
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

/** The apps prompts skip: added from a prompt's "Don't ask", by hand, or from a file. */
function IgnoredApps({ settings, update }: SectionProps) {
  const { ignoredApps } = settings.micPrompt
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const setIgnored = (next: string[]): void => {
    void update({ micPrompt: { ...settings.micPrompt, ignoredApps: next } })
  }
  const add = (): void => {
    const { apps, added } = mergeIgnoredApps(ignoredApps, [name])
    setNotice(added ? null : `${name.trim()} is already on the list.`)
    if (added) setIgnored(apps)
    setName('')
  }
  const exportList = async (): Promise<void> => {
    const result = await window.api.exportIgnoredApps()
    if (result.status === 'saved') {
      setNotice(`Exported ${String(result.count)} ${result.count === 1 ? 'app' : 'apps'}.`)
    }
  }
  const importList = async (): Promise<void> => {
    const result = await window.api.importIgnoredApps()
    switch (result.status) {
      case 'cancelled':
        return
      case 'invalid':
        setNotice(result.message)
        return
      case 'imported':
        setNotice(
          result.added
            ? `Added ${String(result.added)} ${result.added === 1 ? 'app' : 'apps'}.`
            : 'Every app in that file was already on the list.'
        )
    }
  }
  return (
    <>
      <Row
        label="Never ask for"
        hint="Prompts skip these apps. Use the name a prompt shows, like Zoom, Google Meet or obs64."
      >
        <input
          className="settings-input"
          value={name}
          maxLength={100}
          placeholder="App name"
          onChange={(event) => {
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) add()
          }}
          aria-label="App to never ask about"
        />
        <button className="btn" type="button" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </Row>
      {ignoredApps.length ? (
        <ul className="settings-chips is-block">
          {ignoredApps.map((app) => (
            <li key={app}>
              {app}
              <button
                type="button"
                aria-label={`Ask again for ${app}`}
                {...tip('Ask again')}
                onClick={() => {
                  setIgnored(ignoredApps.filter((entry) => entry !== app))
                }}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Row label="Share the list" hint="Save it to a file, or add the apps from one.">
        <button className="btn" type="button" onClick={() => void importList()}>
          Import…
        </button>
        <button
          className="btn"
          type="button"
          disabled={!ignoredApps.length}
          onClick={() => void exportList()}
        >
          Export…
        </button>
      </Row>
      {notice ? <p className="settings-notice">{notice}</p> : null}
    </>
  )
}

function PromptsSection({ settings, update }: SectionProps) {
  const { enabled } = settings.micPrompt
  const setPrompt = (patch: Partial<SettingsValue['micPrompt']>): void => {
    void update({ micPrompt: { ...settings.micPrompt, ...patch } })
  }
  return (
    <Section title="Prompts">
      <Row
        label="Offer to record meetings"
        hint="When a call starts in Zoom, Teams, Slack, Discord, or Google Meet in your browser, offer to record it. Works while Lyra is closed to the tray; it checks on this computer only."
      >
        <Switch
          label="Offer to record meetings"
          checked={settings.meetingPrompt}
          onChange={(meetingPrompt) => void update({ meetingPrompt })}
        />
      </Row>
      <Row
        label="Offer a session when the mic turns on"
        hint="When any other app starts using your microphone, ask whether to start a session."
      >
        <Switch
          label="Offer a session when the mic turns on"
          checked={enabled}
          onChange={(next) => {
            setPrompt({ enabled: next })
          }}
        />
      </Row>
      <IgnoredApps settings={settings} update={update} />
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
  { id: 'performance', label: 'Performance', icon: <GaugeIcon /> },
  { id: 'about', label: 'About', icon: <InfoIcon /> }
]

function MicrophoneSection({ settings, update }: SectionProps) {
  const permissions = usePermissions()
  return (
    <Section title="Microphone">
      <Row label="Input device" hint="Used for every session.">
        <MicrophoneSelect
          value={settings.micDeviceId}
          onChange={(micDeviceId) => void update({ micDeviceId })}
        />
      </Row>
      <PermissionRow kind="microphone" status={permissions} />
    </Section>
  )
}

export function SettingsDialog({ settings, update: rawUpdate, issues, onClose }: Props) {
  // Open on the tab with a problem, so the badge that brought the user here leads somewhere.
  const [tab, setTab] = useState<SettingsTab>(() => issues[0]?.tab ?? 'general')
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]
  const update = useUndoableUpdate(settings, rawUpdate)
  const dialog = useRef<HTMLDivElement>(null)
  // Focus starts in the dialog, Tab stays in it, and goes back where it was on close.
  useDialogFocus(dialog, true)

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
        ref={dialog}
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
                <MicrophoneSection settings={settings} update={update} />
                <StartupSection settings={settings} update={update} />
              </>
            ) : null}
            {tab === 'sessions' ? (
              <>
                <RecordingSection settings={settings} update={update} saveRetention={rawUpdate} />
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
            {tab === 'about' ? <AboutSettings /> : null}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

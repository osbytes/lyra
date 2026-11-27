import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PROVIDERS, ProviderId, type KeySource } from '../../../shared/ai'
import { formatBytes } from '../../../shared/bytes'
import { WHISPER_LANGUAGES } from '../../../shared/languages'
import { mergeIgnoredApps } from '../../../shared/ignoredApps'
import { isStricterRetention } from '../../../shared/retention'
import type {
  NotesBackfill,
  NotesBackfillKind,
  NotesTestResult,
  ProcessUsage,
  Settings as SettingsValue
} from '../../../shared/types'
import { useActivity } from '../hooks/useActivity'
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
import { setDensity, useDensity } from '../lib/density'
import { homePath } from '../lib/format'
import { drawAttention } from '../lib/motion'
import { record } from '../lib/history'
import { ipcErrorMessage } from '../lib/ipcError'
import { hostedPrivacy } from '../lib/summaryPrivacy'
import { cn } from '../lib/utils'
import { AboutSettings, InfoIcon } from './About'
import { ConfirmDialog } from './ConfirmDialog'
import { ScrollArea, Segmented, Select, Switch } from './Controls'
import { HotkeyInput } from './HotkeyInput'
import { CloseIcon, FolderIcon, GaugeIcon, GearIcon, PeopleIcon, RecordIcon } from './Icons'
import { LocalServerSettings, TestResult } from './LocalServer'
import { MicrophoneSelect } from './MicrophoneSelect'
import { ModelStatusLine } from './ModelStatusLine'
import { PeopleSettings } from './People'
import { PermissionRow } from './Permissions'
import { CommitInput, Row, Section, type SectionProps, type Update } from './SettingsParts'
import { tip } from './Tooltip'
import { UsageChart } from './UsageChart'
import { VocabularyEditor } from './Vocabulary'
import { Button } from './ui/button'

/** Where to open Preferences: a tab, and a section on it to bring into view and outline. */
export type SettingsFocus = { tab: SettingsTab; section?: string }

type Props = {
  settings: SettingsValue
  update: Update
  issues: SettingsIssue[]
  onClose: () => void
  focus?: SettingsFocus | null
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
          <Button
           
            type="button"
            disabled={busy !== null}
            onClick={() => void changeFolder()}
          >
            Change…
          </Button>
          <Button
           
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
          </Button>
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
            <Button type="button" onClick={() => void update({ hotkey: DEFAULT_HOTKEY })}>
              Reset
            </Button>
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
            <Button type="button" onClick={() => void saveKey(null)}>
              Remove key
            </Button>
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
              <Button
               
                type="button"
                disabled={!key.trim()}
                onClick={() => void saveKey(key)}
              >
                Save
              </Button>
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
        <Button type="button" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? 'Testing…' : 'Test'}
        </Button>
      </Row>
      {state.result ? <TestResult result={state.result} /> : null}
    </>
  )
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/**
 * Notes for sessions recorded before the current notes pipeline, or before summaries were on.
 * Each session's notes record the pipeline that made them, so this finds the ones worth
 * redoing; a summary the user edited is never touched.
 */
function NotesBackfillRows() {
  const [status, setStatus] = useState<NotesBackfill | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The run reports to Activity, so its progress and result survive closing Settings.
  const { items } = useActivity()
  const run = items.find((item) => item.id === 'backfill') ?? null
  const running = run?.state === 'running' || status?.running === true
  const refresh = useCallback(() => {
    window.api.notesBackfillStatus().then(setStatus, (caught: unknown) => {
      setError(ipcErrorMessage(caught))
    })
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh, run?.state])

  const start = (kind: NotesBackfillKind): void => {
    setError(null)
    window.api.backfillNotes(kind).catch((caught: unknown) => {
      // Shown from its Activity row as well; this covers a refusal before it started.
      setError(ipcErrorMessage(caught))
    })
  }
  const button = (kind: NotesBackfillKind, label: string) => (
    <Button type="button" disabled={running} onClick={() => start(kind)}>
      {label}
    </Button>
  )

  const edited = status?.edited ? ` ${plural(status.edited, 'summary', 'summaries')} you edited stay as they are.` : ''
  const tone = !run ? null : run.state === 'running' ? 'busy' : run.state === 'done' ? 'ready' : 'error'
  return (
    <>
      {status?.outdated ? (
        <Row
          label="Older summaries"
          hint={`${plural(status.outdated, 'summary was', 'summaries were')} written by an earlier version of Lyra. Rewriting gives them sections and better action items.${edited}`}
        >
          {button('outdated', 'Rewrite')}
        </Row>
      ) : null}
      {status?.missing ? (
        <Row
          label="Meetings without a summary"
          hint={`${plural(status.missing, 'meeting has', 'meetings have')} no summary yet, from before summaries were on.`}
        >
          {button('missing', 'Write')}
        </Row>
      ) : null}
      {run && tone ? (
        <div className={`settings-model is-${tone}`}>
          <div className="settings-model-line">
            <span className="visually-hidden" role="status">
              {run.title}
            </span>
            <span className="settings-model-text" aria-hidden="true">
              {run.title}
              {run.detail ? ` · ${run.detail}` : ''}
            </span>
            {run.state === 'running' ? (
              <Button variant="ghost" className="settings-model-action" type="button" onClick={() => void window.api.activityAct(run.id, 'cancel')}>
                Stop
              </Button>
            ) : (
              <Button variant="ghost" className="settings-model-action" type="button" onClick={() => void window.api.dismissActivity(run.id)}>
                Dismiss
              </Button>
            )}
          </div>
          {run.state === 'running' && run.progress !== null ? (
            <div className="settings-model-bar" aria-hidden="true">
              <span style={{ width: `${String(run.progress * 100)}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="settings-notice is-error" role="alert">
          {error}
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
      {choice === 'local' ? <ModelStatusLine feature="localNotes" /> : null}
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
      {settings.semanticSearch ? <ModelStatusLine feature="semanticSearch" /> : null}
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
        <Button type="button" disabled={!name.trim()} onClick={add}>
          Add
        </Button>
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
        <Button type="button" onClick={() => void importList()}>
          Import…
        </Button>
        <Button
         
          type="button"
          disabled={!ignoredApps.length}
          onClick={() => void exportList()}
        >
          Export…
        </Button>
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

/** Comfortable or compact rows and controls; never smaller reading type. */
function AppearanceSection() {
  const density = useDensity()
  return (
    <Section title="Appearance">
      <Row label="Density" hint="Compact fits more sessions and lines on screen. Reading text keeps its size.">
        <Segmented
          label="Density"
          value={density}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' }
          ]}
          onChange={setDensity}
        />
      </Row>
    </Section>
  )
}

export function SettingsDialog({ settings, update: rawUpdate, issues, onClose, focus }: Props) {
  // Open where the launcher pointed, else on the tab with a problem, so the badge that brought
  // the user here leads somewhere.
  const [tab, setTab] = useState<SettingsTab>(() => focus?.tab ?? issues[0]?.tab ?? 'general')
  // Asked for a section: show it and outline it, once it has rendered.
  useEffect(() => {
    if (!focus?.section) return
    setTab(focus.tab)
    const frame = requestAnimationFrame(() => {
      const section = dialog.current?.querySelector(`[data-section="${CSS.escape(focus.section ?? '')}"]`)
      section?.scrollIntoView({ block: 'start', behavior: 'instant' })
      drawAttention(section?.querySelector('.settings-card') ?? section ?? null)
    })
    return () => cancelAnimationFrame(frame)
  }, [focus])
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
        className="modal settings grid grid-cols-[208px_minmax(0,1fr)] overflow-hidden rounded-xl border-(length:--border-width) border-border bg-background shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="settings-nav flex flex-col gap-0.5 border-r border-border bg-card p-2.5" aria-label="Preferences sections">
          <h2 className="m-0 px-2.5 pt-2 pb-2.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">Preferences</h2>
          {TABS.map((entry) => {
            const flagged = issues.some((issue) => issue.tab === entry.id)
            return (
              <button
                key={entry.id}
                type="button"
                className={cn(
                  'relative flex h-8 items-center gap-2 rounded-sm px-2.5 text-left text-body-sm text-text-2 hover:bg-accent hover:text-foreground',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  entry.id === tab && 'bg-brand-soft font-medium text-brand-text hover:bg-brand-soft hover:text-brand-text'
                )}
                aria-current={entry.id === tab ? 'page' : undefined}
                aria-label={flagged ? `${entry.label} (needs attention)` : undefined}
                onClick={() => {
                  setTab(entry.id)
                }}
              >
                {entry.icon}
                {entry.label}
                {flagged ? (
                  <span
                    aria-hidden="true"
                    className="ml-auto size-2 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]"
                  />
                ) : null}
              </button>
            )
          })}
        </nav>
        <div className="settings-main flex min-h-0 flex-col">
          <header className="modal-header flex items-center gap-2 px-6 pt-5 pb-3">
            <h2 className="m-0 flex-1 text-[20px] leading-[26px] font-semibold">{active?.label}</h2>
            <Button
              variant="ghost" size="icon"
              type="button"
              onClick={onClose}
              aria-label="Close preferences"
              {...tip('Close', 'Esc')}
            >
              <CloseIcon />
            </Button>
          </header>
          <ScrollArea className="modal-body px-6 pb-6">
            {tab === 'general' ? (
              <>
                <AppearanceSection />
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

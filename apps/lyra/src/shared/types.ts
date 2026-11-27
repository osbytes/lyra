import { z } from 'zod'
import type { Settings } from './settings'
import type { KeySource, ProviderId } from './ai'
import type { ActivityAction, ActivityItem } from './activity'
import type { PromptApp, PromptAppRequest } from './promptApps'
import type { SessionChanges, SessionDoc, SessionOp } from './sessionDoc'

export type Page = {
  id: string
  title: string
  body: string
  updatedAt: string
}

export type { NoteFormat, Settings } from './settings'
export type { KeySource, ProviderId } from './ai'

export type MoveNotesResult = { moved: number; skipped: number }

/** One group of Lyra's processes: the main process (with Whisper), the windows, each worker. */
export type ProcessUsage = {
  kind: 'main' | 'windows' | 'speakers' | 'notes' | 'search' | 'graphics' | 'other'
  /** Share of the whole computer's CPU since the last reading, 0–100. */
  cpuPercent: number
  memoryBytes: number
}

/** One reading of Lyra's processes (`app.getAppMetrics`). */
export type UsageSample = {
  /** Epoch ms. */
  at: number
  cpuPercent: number
  memoryBytes: number
  processes: ProcessUsage[]
}

/** How much of the computer Lyra has used lately. */
export type AppUsage = {
  intervalMs: number
  /** The computer's total memory, so the UI can show Lyra's share of it. */
  totalMemoryBytes: number
  /** Oldest first; up to 30 minutes. Empty until the first interval has passed. */
  samples: UsageSample[]
}

export const SessionPhase = z.enum(['idle', 'starting', 'listening', 'finishing'])
export type SessionPhase = z.infer<typeof SessionPhase>

/** What the main window's recorder is doing; mirrored to the tray and the overlay. */
export const SessionState = z.object({
  phase: SessionPhase,
  /** Epoch ms when listening began, or null when idle. */
  startedAt: z.number().nullable().catch(null),
  micName: z.string().catch(''),
  /** Computer audio is recorded too, so the pill's meter icon says so. */
  systemAudio: z.boolean().catch(false)
})
export type SessionState = z.infer<typeof SessionState>

const Level = z.number().transform((value) => Math.max(0, Math.min(1, value)))

/** The recording pill's levels, per source; `system` is null when computer audio is off. */
export const OverlayFrame = z.object({ mic: Level, system: Level.nullable() })
export type OverlayFrame = z.infer<typeof OverlayFrame>

/** Sent from main to the main window's recorder. */
export type SessionCommand =
  | { type: 'toggle' }
  | { type: 'stop' }
  /** Start a new session unless one is recording; a meeting always records the computer's audio. */
  | { type: 'start'; meeting: boolean }

/**
 * The overlay's offer to record. `meeting`: a meeting app or meeting site took the mic, and `app`
 * is its name ("Zoom"). `mic`: any other app, by its exe or bundle name; '' when unknown (macOS).
 */
export type MicPrompt = { kind: 'meeting' | 'mic'; app: string }
export type PromptAnswer = 'start' | 'dismiss' | 'ignore'

/** Exporting the "Don't ask" list to a file the user picks. */
export type ExportIgnoredResult = { status: 'cancelled' } | { status: 'saved'; count: number }
/** Importing it: names are only ever added, never removed. */
export type ImportIgnoredResult =
  | { status: 'cancelled' }
  | { status: 'imported'; added: number; total: number }
  | { status: 'invalid'; message: string }

/** One global shortcut starts or stops a session from anywhere. */
export type HotkeyAction = 'session'

export type HotkeyStatus = {
  action: HotkeyAction
  accelerator: string
  registered: boolean
  error: string | null
}

export type AudioTrack = 'mic' | 'system'

/** A finished meeting recording: 16 kHz mono 16-bit WAV files in `<notes>/.audio`. */
export type MeetingRecording = {
  pageId: string
  micPath: string
  /** null when system audio wasn't captured. */
  systemPath: string | null
  seconds: number
}

/** A saved voice (voiceprint). Embeddings stay in main. */
export type Person = {
  id: string
  name: string
  /** The person using this computer; their mic track is labeled with this name. */
  self: boolean
  createdAt: string
  /** How many voice samples the voiceprint is built from. */
  samples: number
}

/** Relabel a meeting speaker as a saved person, or under a new name (optionally saving their voice). */
export type SpeakerAssignment =
  | { personId: string }
  | { name: string; remember: boolean }

/**
 * Whether the recording in progress has speech waiting to be transcribed. Speech still being
 * spoken isn't counted: it's cut into a chunk at the next pause, and only then waits for Whisper.
 */
export type TranscriptProgress = {
  pageId: string
  /** Chunks of speech waiting for (or in) Whisper. */
  queued: number
  /** Seconds of audio in those chunks: how far behind the transcript is. */
  queuedSeconds: number
  /** What Whisper is running on; 'cpu' after a GPU failure is the usual reason for falling behind. */
  backend: 'gpu' | 'cpu'
}

/** A recording that stopped because its audio couldn't be written (a full disk, usually). */
export type RecorderFailure = { pageId: string; track: 'mic' | 'system'; message: string }

export type MeetingStatus = {
  pageId: string
  /** Which job this is about: settling who spoke, or writing the summary. */
  task: 'speakers' | 'notes'
  state: 'downloading' | 'diarizing' | 'transcribing' | 'summarizing' | 'done' | 'error'
  /** 0–1 within the current state. */
  progress: number
  message?: string
  /**
   * For a step that can't count its own progress (finding who spoke when): when it began and how
   * long it's expected to take, from the audio's length, so the UI can say how long is left.
   */
  estimate?: { startedAt: number; expectedMs: number }
}

export type PageSummary = {
  id: string
  title: string
  updatedAt: string
  preview: string
  tags: string[]
  /** Distinct speakers in the session's transcript; 0 when it has none. */
  speakers: number
  startedAt: string
  /** Length of the recording, or null when nothing was recorded. */
  seconds: number | null
}

/** Where in a session a search matched. */
export type SearchField = 'title' | 'tags' | 'summary' | 'notes' | 'transcript'

/** One matched paragraph or transcript line, split into matched and unmatched runs. */
export type SearchMatch = {
  field: SearchField
  parts: { text: string; hit: boolean }[]
  /** Transcript lines only: who said it, when (seconds), and the line's id to jump to. */
  speaker: string | null
  start: number | null
  line: string | null
}

/**
 * A session that matched a search, best match first. `score` is the relevance (higher is
 * better; 0 when only filters matched), comparable within one search only.
 */
export type SearchHit = PageSummary & { score: number; matches: SearchMatch[] }

export type WhisperStatus =
  | { state: 'idle' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'error'; message: string }

/** A transcribed word. `text` keeps Whisper's leading space; times are in seconds. */
export type TranscriptWord = {
  text: string
  start: number
  end: number
}

/** How many sessions a stricter "Keep audio" would take the audio from now, and its size. */
export type RetentionPreview = { sessions: number; bytes: number }

/** A local summary server Settings found on this computer (`detectServers`). */
export type NotesServer = { kind: 'ollama' | 'lm-studio'; baseUrl: string }

/** The models a summary server offers; `ollama` servers on this computer keep text on it. */
export type ServerModels = { models: string[]; kind: 'ollama' | 'other' }

/** A Settings "Test" of the summary engine: how long one tiny request took, or why it failed. */
/**
 * Sessions whose notes a bulk run would write: `outdated`, made by an older notes pipeline and
 * untouched since; `missing`, meetings without notes. `edited` notes are never rewritten in bulk.
 */
export type NotesBackfill = { outdated: number; missing: number; edited: number; running: boolean }
export type NotesBackfillKind = 'outdated' | 'missing'
/**
 * Where a session's notes stand against the current notes pipeline: `current`, written by it;
 * `outdated`, by an older one and untouched since; `edited`, changed by the user; `missing`, a
 * meeting with no notes yet; `none`, no notes and nothing that would get them.
 */
export type NotesState = 'current' | 'outdated' | 'edited' | 'missing' | 'none'
export type NotesBackfillResult = { written: number; failed: number; stopped: boolean }

export type NotesTestResult = { ok: true; ms: number; onDevice: boolean } | { ok: false; error: string }

/** A permission the OS asks the user for. */
export type PermissionKind = 'microphone' | 'screen'
/** As `systemPreferences.getMediaAccessStatus` reports it; 'granted' where the OS doesn't ask. */
export type PermissionState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
export type PermissionStatus = Record<PermissionKind, PermissionState>

/** Lyra's own folders Settings → About can open. */
export type RevealTarget = 'logs' | 'models'

/** A folder Lyra keeps files in, its path with the home folder as `~`, and the room it takes. */
export type DiagnosticsPlace = {
  id: 'models' | 'audio' | 'index' | 'logs'
  label: string
  path: string
  bytes: number
  /** False when the folder had more files than were counted: `bytes` is then a floor. */
  complete: boolean
}

/** The computer Lyra runs on: what a slow or failed session is first checked against. */
export type MachineInfo = {
  cpu: string
  cores: number
  memoryGb: number
  /** The active graphics adapter, when the system names one. */
  gpu: string | null
}

/** CPU (percent of one core) and memory in MB of one kind of Lyra process, as the log has them. */
export type ProcessLoad = { cpu: number; mb: number }

/** One sample of what Lyra and the machine were using (`resources.ts`). Numbers only. */
export type ResourceSample = {
  at: string
  processes: Record<string, ProcessLoad>
  freeMb: number
  totalMb: number
  load1: number
  cores: number
  diskFreeGb: number | null
  thermal: string | null
  onBattery: boolean
}

/** Settings → About. No note content, names, keys, addresses or queries. */
export type Diagnostics = {
  version: string
  os: string
  arch: string
  electron: string
  chrome: string
  node: string
  /** `backend` is null until Whisper has run since launch. */
  whisper: { model: string; backend: 'gpu' | 'cpu' | null }
  notesEngine: string
  machine: MachineInfo
  /** What Lyra and the machine are using right now; null if it couldn't be measured. */
  resources: ResourceSample | null
  places: DiagnosticsPlace[]
  /** All of the above as plain text, for "Copy diagnostics". */
  text: string
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/** A setting whose model downloads on first use, so Settings shows how that is going. */
export type ModelFeature = 'semanticSearch' | 'localNotes'

/**
 * Where a feature's model stands, keyed by `model` (its file name, which `cancelModelDownload`
 * takes). `reading` is semantic search embedding sessions after the download: `done` of `total`
 * passages. `missing` means it downloads on first use; nothing has asked for it yet.
 */
export type ModelStatus = { feature: ModelFeature; model: string } & (
  | { state: 'missing' }
  | { state: 'downloading'; received: number; total: number }
  /** `pausedFor`: embedding waits while recording and on battery, so the count holds still. */
  | { state: 'reading'; done: number; total: number; pausedFor: 'recording' | 'battery' | null }
  | { state: 'ready' }
  | { state: 'cancelled' }
  | { state: 'error'; message: string }
)

/** Who a speaker turned out to be (`resolveSpeaker`). */
export type SpeakerIdentity = { name: string; personId: string | null }

/** An open session as main holds it: its document, and how many changes it has had. */
export type SessionOpened = { rev: number; doc: SessionDoc }

/**
 * A change to an open session, from anyone (this window included): the fields that changed,
 * whole. `rev` counts changes, one at a time, so a window can tell it missed one. `ack` is set
 * for the window whose edits these were: the `seq` of its last edit main has applied.
 */
export type SessionChangeEvent = { id: string; rev: number; changes: SessionChanges; ack: number | null }

export type VoicePagesApi = {
  listPages: () => Promise<PageSummary[]>
  /** Full-text search across every session's title, notes, transcript and tags. */
  searchPages: (query: string) => Promise<SearchHit[]>
  getPage: (id: string) => Promise<Page>
  /** `startedAt` (ISO) names the file after a session's start time; defaults to now. */
  createPage: (options?: { startedAt?: string }) => Promise<Page>
  savePage: (page: Pick<Page, 'id' | 'title' | 'body'>) => Promise<Page>
  /** Deletes a session. It can be restored until Lyra quits, then goes to the system trash. */
  deletePage: (id: string) => Promise<void>
  /** Undoes `deletePage`. */
  restorePage: (id: string) => Promise<void>
  /** Shows a session's text file in the system file manager. */
  revealPage: (id: string) => Promise<void>
  /** Fires when the list of pages, or a page's title or preview, may have changed. */
  onPagesChanged: (callback: () => void) => () => void
  /**
   * Opens a session for this window: resolves to its document, and `onSessionChange` then
   * delivers every change to it. See docs/SESSION-MODEL.md.
   */
  openSession: (id: string) => Promise<SessionOpened>
  /**
   * Sends this window's edits to a session, applied in order as one change. `seq` numbers the
   * window's edits; the change event that carries them echoes it back as `ack`. Resolves to
   * that change's `rev`.
   */
  editSession: (id: string, seq: number, ops: SessionOp[]) => Promise<number>
  /** Stops receiving changes for a session this window no longer shows. */
  closeSession: (id: string) => void
  onSessionChange: (callback: (change: SessionChangeEvent) => void) => () => void
  getSettings: () => Promise<Settings>
  /**
   * Main window only. Applies the fields that pass their checks (a bad value keeps the current
   * one); an unknown field rejects. `notesDir` is refused: the folder changes with `pickFolder`.
   */
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>
  onSettingsChanged: (callback: (settings: Settings) => void) => () => void
  /**
   * Main window only. Opens the native folder picker and switches to the folder the user picks.
   * Resolves to the new settings (unchanged if they picked the current folder), or null when
   * they cancel; rejects while recording.
   */
  pickFolder: () => Promise<Settings | null>
  /** Main window only. Moves the notes from the folder used before the last `pickFolder`. */
  moveNotes: () => Promise<MoveNotesResult>
  /** Main window only. Opens the notes folder in the file manager. */
  revealNotesFolder: () => Promise<void>
  /** CPU and memory Lyra's processes used over the last 30 minutes, sampled in main. */
  getAppUsage: () => Promise<AppUsage>
  /** Main window only. Saves the "Don't ask" app list to a file the user picks. */
  exportIgnoredApps: () => Promise<ExportIgnoredResult>
  /** Main window only. Adds the apps in a file the user picks to the "Don't ask" list. */
  importIgnoredApps: () => Promise<ImportIgnoredResult>
  /** Main window: commands from the tray, global hotkey, or overlay. */
  onSessionCommand: (callback: (command: SessionCommand) => void) => () => void
  /** Main window: report recorder state changes. */
  reportSession: (state: SessionState) => void
  /** Main window: report level and status (throttled by the caller). */
  reportOverlayFrame: (frame: OverlayFrame) => void
  /** Overlay: the recorder's current state, then follow changes with `onSessionState`. */
  getSessionState: () => Promise<SessionState>
  onSessionState: (callback: (state: SessionState) => void) => () => void
  onOverlayFrame: (callback: (frame: OverlayFrame) => void) => () => void
  /** Overlay: the "mic in use" prompt to show, or null to hide it. */
  onMicPrompt: (callback: (prompt: MicPrompt | null) => void) => () => void
  answerMicPrompt: (answer: PromptAnswer) => void
  /** Overlay: ask the recorder to stop. */
  requestStop: () => void
  /** Brings the main window to the front. */
  showMainWindow: () => void
  getHotkeyStatus: () => Promise<HotkeyStatus[]>
  onHotkeyStatus: (callback: (status: HotkeyStatus[]) => void) => () => void
  /** Meeting audio: open WAV files for a page, append 16-bit PCM chunks, then finalize. */
  /**
   * Records into a session's audio; recording again in the same session continues its
   * timeline. Resolves to where this recording starts on it, in seconds.
   */
  startRecording: (pageId: string, withSystem: boolean) => Promise<number>
  /** Captured audio; main transcribes it a chunk at a time and writes the lines itself. */
  appendRecording: (track: AudioTrack, pcm16: Int16Array) => void
  /** Resolves once the last chunks are transcribed and the take is saved. */
  stopRecording: () => Promise<MeetingRecording | null>
  /** Whether the recording in progress has speech waiting to be transcribed. */
  onTranscriptProgress: (callback: (progress: TranscriptProgress) => void) => () => void
  /** The recording stopped in main because its audio couldn't be written. */
  onRecorderFailed: (callback: (failure: RecorderFailure) => void) => () => void
  /** Mixed 16 kHz mono PCM for a stretch of a session's audio (Listen); empty if none is kept. */
  sessionAudio: (pageId: string, start: number, end: number) => Promise<Int16Array>
  listPeople: () => Promise<Person[]>
  onPeopleChanged: (callback: (people: Person[]) => void) => () => void
  /** Saves a voiceprint from ~20 s of 16 kHz mono speech. */
  enrollPerson: (name: string, pcm: Float32Array, self: boolean) => Promise<Person>
  renamePerson: (id: string, name: string) => Promise<void>
  /** Marks who "me" is; null marks nobody. */
  setSelfPerson: (id: string | null) => Promise<void>
  deletePerson: (id: string) => Promise<void>
  /** Undoes `deletePerson` (voiceprint included) until Lyra quits. */
  restorePerson: (id: string) => Promise<void>
  /** Speakers of a processed meeting note, or null if it isn't one. */
  /**
   * Works out who a session's speaker is: a saved person, or a new name. Teaches the voiceprint
   * from that speaker's audio (always for a saved person; for a new name when `remember`).
   * The window applies the returned name to its document, so naming can be undone there.
   */
  resolveSpeaker: (
    pageId: string,
    speakerId: string,
    assignment: SpeakerAssignment
  ) => Promise<SpeakerIdentity>
  /**
   * After lines `moved` left speaker `from`, the ids of `from`'s other lines that sound like the
   * moved ones (empty without kept audio). Moves nothing; the window offers to.
   */
  similarLines: (pageId: string, moved: readonly string[], from: string) => Promise<string[]>
  onMeetingStatus: (callback: (status: MeetingStatus) => void) => () => void
  /** (Re)writes the notes section at the top of a meeting note with the chosen engine. */
  generateNotes: (pageId: string) => Promise<void>
  /** Whether the summary has been changed since Lyra wrote it (so a rewrite would lose edits). */
  summaryEdited: (pageId: string) => Promise<boolean>
  /** Stops a summary being written; resolves to whether one was running. */
  cancelNotes: (pageId: string) => Promise<boolean>
  /** Where a session's notes stand: an `outdated` summary is worth rewriting. */
  notesState: (pageId: string) => Promise<NotesState>
  /** How many sessions' notes are out of date or missing (Settings → Sessions). */
  notesBackfillStatus: () => Promise<NotesBackfill>
  /** Writes those notes, one session at a time; resolves when done or stopped. */
  backfillNotes: (kind: NotesBackfillKind) => Promise<NotesBackfillResult>
  /** Stops `backfillNotes`; resolves to whether it was running. */
  stopBackfillNotes: () => Promise<boolean>
  /** Main window only. Where a provider's API key comes from, or null when there is none. */
  keySource: (provider: ProviderId) => Promise<KeySource | null>
  /**
   * Main window only. Stores a provider's key encrypted with the OS keychain; null removes it.
   * Rejects where there is no real keychain (Linux without one), naming the variable to use.
   */
  setKey: (provider: ProviderId, key: string | null) => Promise<void>
  /**
   * Main window only. How much audio `days` would delete right now (a stricter "Keep audio"
   * deletes on save, so Settings confirms first). Deletes nothing.
   */
  previewRetention: (days: number | null) => Promise<RetentionPreview>
  /** Main window only. Looks for Ollama and LM Studio on this computer; only on a user's click. */
  detectServers: () => Promise<NotesServer[]>
  /** Main window only. Asks the server at `baseUrl` for its models; only on a user's click. */
  listServerModels: (baseUrl: string) => Promise<ServerModels>
  /** Main window only. Runs one tiny fixed request through the saved summary engine. */
  testNotesWriter: () => Promise<NotesTestResult>
  /** Main window only. Versions, folders and their sizes, for Settings → About. */
  getDiagnostics: () => Promise<Diagnostics>
  /** Main window only. Opens the logs or models folder in the file manager. */
  revealFolder: (target: RevealTarget) => Promise<void>
  /** Main window only. Stops a model download in progress; resolves to whether one was. */
  cancelModelDownload: (name: string) => Promise<boolean>
  /** Main window only. Where each feature's model stands now; one entry per feature that has one. */
  modelStatus: () => Promise<ModelStatus[]>
  /** Main window only. Downloads (or loads) a feature's model again, after a failure or cancel. */
  retryModel: (feature: ModelFeature) => Promise<void>
  /** A feature's model changed state: downloading, reading sessions, ready, failed. */
  onModelStatus: (callback: (status: ModelStatus) => void) => () => void
  /** Every long-running task's progress, ending or error (docs/STATES.md). */
  activityList: () => Promise<ActivityItem[]>
  /** Activity changed: the whole list, as main holds it. */
  onActivity: (callback: (items: ActivityItem[]) => void) => () => void
  /** Cancel, Retry or Install on an Activity row (Open is the window's own). */
  activityAct: (id: string, action: Exclude<ActivityAction, 'open'>) => Promise<void>
  /** Removes an ended Activity row; resolves to whether there was one. */
  dismissActivity: (id: string) => Promise<boolean>
  /** Endings the person has now seen (their screen is open, or a toast announced them). */
  markActivitySeen: (ids: string[]) => Promise<void>
  /** Whether the OS lets Lyra use the microphone and capture the screen. */
  permissionStatus: () => Promise<PermissionStatus>
  /** Main window only. Opens the system settings page for a permission; false if there is none. */
  openPermissionSettings: (kind: PermissionKind) => Promise<boolean>
  /** The coding and chat apps installed here that open with a prompt filled in. */
  promptApps: () => Promise<PromptApp[]>
  /** Main window only. Opens an app with the text as its prompt, unsent; says if it was cut. */
  openInPromptApp: (request: PromptAppRequest) => Promise<{ truncated: boolean }>
  /** Puts plain text on the system clipboard. */
  copyText: (text: string) => void
  platform: string
  /** The processor Lyra was built for (`arm64`, `x64`): some models have no build for every one. */
  arch: string
  /** Downloads the model if needed and loads it into memory. */
  warmUp: () => Promise<void>
  /** Appends a line to the app log (terminal + userData/logs/lyra.log). */
  log: (scope: string, message: string, data?: unknown) => void
  onStatus: (callback: (status: WhisperStatus) => void) => () => void
  startUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
}

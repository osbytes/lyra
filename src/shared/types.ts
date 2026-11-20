export type Page = {
  id: string
  title: string
  body: string
  updatedAt: string
}

export type NoteFormat = 'txt' | 'md'

export type Settings = {
  /** Absolute folder that holds the notes. Default `~/.lyra`. */
  notesDir: string
  /** Format used for new notes; both are always readable. */
  fileFormat: NoteFormat
  /** `null` = the system default microphone. */
  micDeviceId: string | null
  /** Electron accelerators for the global shortcuts. */
  hotkey: string
  meetingHotkey: string
  launchAtLogin: boolean
  micPrompt: { enabled: boolean; ignoredApps: string[] }
  keepMeetingAudio: boolean
  captureSystemAudio: boolean
  notesEngine: 'off' | 'local' | 'claude'
  speakerMatchThreshold: number
}

export type MoveNotesResult = { moved: number; skipped: number }

export type SessionKind = 'dictation' | 'meeting'
export type SessionPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** What the main window's recorder is doing; mirrored to the tray and the overlay. */
export type SessionState = {
  phase: SessionPhase
  kind: SessionKind
  /** Epoch ms when listening began, or null when idle. */
  startedAt: number | null
  micName: string
}

/** High-frequency recording feedback for the overlay pill. */
export type OverlayFrame = { level: number; live: string }

/** Sent from main to the main window's recorder. */
export type SessionCommand = { type: 'toggle'; kind: SessionKind } | { type: 'stop' }

export type HotkeyStatus = { accelerator: string; registered: boolean; error: string | null }

export type PageSummary = {
  id: string
  title: string
  updatedAt: string
  preview: string
}

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

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export type VoicePagesApi = {
  listPages: () => Promise<PageSummary[]>
  getPage: (id: string) => Promise<Page>
  /** `startedAt` (ISO) names the file after a session's start time; defaults to now. */
  createPage: (options?: { startedAt?: string }) => Promise<Page>
  savePage: (page: Pick<Page, 'id' | 'title' | 'body'>) => Promise<Page>
  deletePage: (id: string) => Promise<void>
  /** Fires when files in the notes folder change outside of `savePage`. */
  onPagesChanged: (callback: () => void) => () => void
  getSettings: () => Promise<Settings>
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>
  onSettingsChanged: (callback: (settings: Settings) => void) => () => void
  /** Opens a folder picker; resolves to the chosen absolute path or null. */
  pickFolder: () => Promise<string | null>
  /** Moves notes from the old folder into the current one. */
  moveNotes: (fromDir: string) => Promise<MoveNotesResult>
  revealNotesFolder: () => Promise<void>
  /** Main window: commands from the tray, global hotkey, or overlay. */
  onSessionCommand: (callback: (command: SessionCommand) => void) => () => void
  /** Main window: report recorder state changes. */
  reportSession: (state: SessionState) => void
  /** Main window: report level and live text (throttled by the caller). */
  reportOverlayFrame: (frame: OverlayFrame) => void
  /** Overlay: the recorder's current state, then follow changes with `onSessionState`. */
  getSessionState: () => Promise<SessionState>
  onSessionState: (callback: (state: SessionState) => void) => () => void
  onOverlayFrame: (callback: (frame: OverlayFrame) => void) => () => void
  /** Overlay: ask the recorder to stop. */
  requestStop: () => void
  /** Brings the main window to the front. */
  showMainWindow: () => void
  getHotkeyStatus: () => Promise<HotkeyStatus>
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void
  copyText: (text: string) => void
  platform: string
  /** Downloads the model if needed and loads it into memory. */
  warmUp: () => Promise<void>
  /** `prompt` is recent text that gives Whisper context for punctuation and vocabulary. */
  transcribe: (pcm: Uint8Array, prompt: string) => Promise<TranscriptWord[]>
  /** Appends a line to the app log (terminal + userData/logs/lyra.log). */
  log: (scope: string, message: string, data?: unknown) => void
  onStatus: (callback: (status: WhisperStatus) => void) => () => void
  startUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
}

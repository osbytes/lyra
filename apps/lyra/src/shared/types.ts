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
  /** Electron accelerator for the global start/stop shortcut. */
  hotkey: string
  launchAtLogin: boolean
  micPrompt: { enabled: boolean; ignoredApps: string[] }
  /**
   * Days to keep recorded audio after a session: `null` keeps it forever, `0` deletes it once
   * the transcript is labeled. Transcripts are always kept.
   */
  audioRetentionDays: number | null
  captureSystemAudio: boolean
  notesEngine: 'off' | 'local' | 'claude'
  /** Show a session's details (dates, tags, speakers) in a side panel instead of inline. */
  detailsPanel: boolean
  /** The one-time "get consent before recording others" notice was acknowledged. */
  meetingNoticeSeen: boolean
}

export type MoveNotesResult = { moved: number; skipped: number }

export type SessionPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** What the main window's recorder is doing; mirrored to the tray and the overlay. */
export type SessionState = {
  phase: SessionPhase
  /** Epoch ms when listening began, or null when idle. */
  startedAt: number | null
  micName: string
}

/** High-frequency recording feedback for the overlay pill. */
export type OverlayFrame = { level: number; live: string }

/** Sent from main to the main window's recorder. */
export type SessionCommand = { type: 'toggle' } | { type: 'stop' }

/** "Another app started using the mic" prompt. `app` is '' when the app is unknown (macOS). */
export type MicPrompt = { app: string }
export type PromptAnswer = 'start' | 'dismiss' | 'ignore'

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

export type MeetingStatus = {
  pageId: string
  state: 'downloading' | 'diarizing' | 'transcribing' | 'summarizing' | 'done' | 'error'
  /** 0–1 within the current state. */
  progress: number
  message?: string
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

/** A Yjs update to an open session, made outside this window. */
export type SessionUpdate = { id: string; update: Uint8Array }

export type VoicePagesApi = {
  listPages: () => Promise<PageSummary[]>
  getPage: (id: string) => Promise<Page>
  /** `startedAt` (ISO) names the file after a session's start time; defaults to now. */
  createPage: (options?: { startedAt?: string }) => Promise<Page>
  savePage: (page: Pick<Page, 'id' | 'title' | 'body'>) => Promise<Page>
  deletePage: (id: string) => Promise<void>
  /** Shows a session's text file in the system file manager. */
  revealPage: (id: string) => Promise<void>
  /** Fires when the list of pages, or a page's title or preview, may have changed. */
  onPagesChanged: (callback: () => void) => () => void
  /**
   * Opens a session's Yjs document for this window: resolves to its full state as one update,
   * and `onSessionUpdate` then delivers changes made elsewhere. See docs/SESSION-MODEL.md.
   */
  openSession: (id: string) => Promise<Uint8Array>
  /** Sends a Yjs update made in this window; resolves once main has persisted it. */
  updateSession: (id: string, update: Uint8Array) => Promise<void>
  /** Stops receiving updates for a session this window no longer shows. */
  closeSession: (id: string) => void
  onSessionUpdate: (callback: (change: SessionUpdate) => void) => () => void
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
  appendRecording: (track: AudioTrack, pcm16: Int16Array) => void
  /** Words the live transcriber committed, timed on the session's timeline. */
  appendRecordingWords: (words: TranscriptWord[]) => void
  stopRecording: () => Promise<MeetingRecording | null>
  /** Mixed 16 kHz mono PCM for a stretch of a session's audio (Listen); empty if none is kept. */
  sessionAudio: (pageId: string, start: number, end: number) => Promise<Int16Array>
  listPeople: () => Promise<Person[]>
  onPeopleChanged: (callback: (people: Person[]) => void) => () => void
  /** Saves a voiceprint from ~20 s of 16 kHz mono speech. */
  enrollPerson: (name: string, pcm: Float32Array, self: boolean) => Promise<Person>
  renamePerson: (id: string, name: string) => Promise<void>
  setSelfPerson: (id: string) => Promise<void>
  deletePerson: (id: string) => Promise<void>
  /** Speakers of a processed meeting note, or null if it isn't one. */
  /**
   * Names a session's speaker as a saved person, or under a new name. Teaches the voiceprint
   * from that speaker's audio (always for a saved person; for a new name when `remember`).
   */
  assignSpeaker: (pageId: string, speakerId: string, assignment: SpeakerAssignment) => Promise<void>
  onMeetingStatus: (callback: (status: MeetingStatus) => void) => () => void
  /** (Re)writes the notes section at the top of a meeting note with the chosen engine. */
  generateNotes: (pageId: string) => Promise<void>
  hasClaudeKey: () => Promise<boolean>
  /** Stores the key encrypted with the OS keychain; null removes it. */
  setClaudeKey: (key: string | null) => Promise<void>
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

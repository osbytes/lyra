export type Track = 'mic' | 'system'

/** A diarized voice in the demo call, shaped like the app's SpeakerEntry. */
export type Speaker = {
  id: string
  name: string
  /** The label diarization gives before a saved voice matches, e.g. `Speaker 2`. */
  anon: string
  confirmed: boolean
  confidence: number | null
  personId: string | null
  track: Track
  /** Seconds into the call when the saved-voice match lands during playback; null if never. */
  matchAt: number | null
}

export type SpeakerState = 'sure' | 'likely' | 'unknown'

/** One transcript segment, shaped like the app's TranscriptSegment. */
export type Line = {
  id: string
  cluster: string
  start: number
  end: number
  confidence: number | null
  text: string
  /** What the model heard, before any edit. */
  original: string
}

export type Session = {
  /** The export's file name, as in the app: `2026-11-23_10-30-00.txt`. */
  id: string
  ext: 'txt' | 'md'
  title: string
  tags: string[]
  body: string
  /** Meeting notes: null means generated from the transcript, a string means edited. */
  summary: string | null
  meeting: boolean
  startedAt: number
  editedAt: number
  seconds: number
  tracks: Track[]
  /** Created in the demo by the visitor. */
  fromDemo: boolean
}

export type Retention = 'none' | '7' | '30' | 'always'
export type NotesEngine = 'off' | 'local' | 'cloud'

export type Settings = {
  retention: Retention
  systemAudio: boolean
  notesEngine: NotesEngine
  noticeSeen: boolean
}

export type FileSelection = { kind: 'export' | 'meta'; id: string } | { kind: 'sessions' }

export type DemoState = {
  /** The demo's clock, in epoch ms. */
  now: number
  sessions: Session[]
  speakers: Speaker[]
  lines: Line[]
  /** Checked action items in the meeting notes, by index. */
  doneActions: boolean[]
  settings: Settings
  currentId: string
  tagFilter: string | null
  panel: boolean
  /** Where the transcriber writes in the open session's body; null when it isn't recording. */
  transcriberAt: number | null
  trashed: { session: Session; index: number } | null
  selectedFile: FileSelection
  notesBusy: boolean
}

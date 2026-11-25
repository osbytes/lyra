# Session data model

Status: implemented (2026-11-23), phases 1–4. Replaces the page model in
`apps/lyra/src/main/pages.ts` and the meeting sidecars in `.audio/` and `.meta/`.

Decisions:
- **Audio is kept for 30 days by default**, configurable (Always / N days / Delete after
  transcription).
- **The text file is an export.** Lyra writes it; it doesn't read edits back yet. Making it
  two-way is a likely next step: an agent (or another editor) editing the file directly is a
  real use case, and the design below keeps that open.
- **Every export has a metadata file beside it** (`<stem>.lyra.json`) describing speakers,
  confidence, segments with timings, tags and timestamps, with relative paths to the raw audio
  and transcript passes. It is what an agent or script reads to understand a session without
  parsing Lyra's private folders.

## Why change

Today a session is one `.txt`/`.md` file, and everything else is bolted on:

- **Audio** is only recorded for meetings (`recorder.ts`, `<notes>/.audio/*.wav`) and is deleted
  after labeling unless "Keep meeting audio" is on. Dictation keeps no audio at all.
- **The transcript is flattened into the note body** as `[hh:mm:ss] Name: text` lines
  (`pipeline.ts` `transcribeTurns`). Word timings, per-segment confidence and the raw Whisper
  output are thrown away. The live text is kept only as `liveTranscript` in `.meta/*.json`.
- **Edits and machine writes race.** The renderer autosaves the whole body every 400 ms. The
  meeting pipeline, relabeling (`relabel()` rewrites names with a regex over the body) and notes
  generation each read the file, rewrite it and save it. Whichever writes last wins, and
  `usePages` papers over this with `hasPendingSave()` checks.
- **Nothing links text back to audio**, so you can't play a line, fix a word and keep its timing,
  or see what the model originally heard.

The product now treats everything as a **session**: one recording with a transcript the user can
edit, speakers, tags and notes. The data model should hold all of that without losing the raw
capture.

## The model

Three layers, from least to most mutable:

| Layer | What | Mutability | Where |
| --- | --- | --- | --- |
| **Audio** | The raw capture, one track per source (`mic`, `system`) | Write once, append while recording | `audio/*.wav` |
| **Raw transcript** | What the models produced: segments, words with timings, confidence, diarization | Immutable per *pass*. A re-run adds a new pass, it never edits one | `raw/<pass>.json` |
| **Document** | What the user sees and edits: title, tags, notes, transcript, speaker names | Fully editable. A Yjs CRDT | `doc.yjs` |

Plus a readable **export**: the familiar `.txt`/`.md` file in the notes folder, rendered from the
document, and a **metadata file** beside it. Together they are what other tools, scripts and
agents open, grep and sync.

```
~/.lyra/
  2026-11-23_10-30-00.txt                  ← export: title, notes, transcript as plain text
  2026-11-23_10-30-00.lyra.json            ← export metadata: speakers, confidence, segments, audio links
  .sessions/2026-11-23_10-30-00.txt/
    session.json                           ← manifest (small, plain JSON, versioned)
    audio/mic.wav  audio/system.wav        ← raw capture
    raw/live.json                          ← words transcribed during recording, per track
    raw/pass-1.json                        ← diarization + per-turn re-transcription
    doc.yjs                                ← Yjs update log (the editable document)
```

The session folder is named after the export's full file name, which is today's page id, so
`a.txt` and `a.md` can never share one. Hidden folders keep the notes folder clean in Finder and
Explorer; they replace `.audio/` and `.meta/`.

### Export metadata (`<stem>.lyra.json`)

Regenerated with the export. It is a stable, documented format, written for readers that aren't
Lyra:

```jsonc
{
  "schema": "lyra.session/1",
  "id": "2026-11-23_10-30-00.txt",
  "export": "2026-11-23_10-30-00.txt",      // the text file this describes
  "generatedBy": "Lyra 0.3.0",
  "editable": false,                         // the text file is an export; edits are not read back yet
  "title": "Design review",
  "tags": ["design", "team"],
  "startedAt": "…", "endedAt": "…", "updatedAt": "…",
  "durationSeconds": 2472, "words": 1284,
  "audio": [                                 // paths relative to this file
    { "track": "mic", "path": ".sessions/2026-11-23_10-30-00.txt/audio/mic.wav",
      "sampleRate": 16000, "seconds": 2472, "retainedUntil": "2026-12-23" }
  ],
  "rawTranscripts": [{ "id": "pass-1", "kind": "diarized", "path": ".sessions/…/raw/pass-1.json" }],
  "speakers": [
    { "id": "c1", "name": "Sam", "personId": "…", "confirmed": false,
      "confidence": 0.71, "talkSeconds": 192, "segments": 14 }
  ],
  "segments": [
    { "id": "s042", "start": 31.2, "end": 36.8, "speaker": "c1", "confidence": 0.52,
      "edited": false, "text": "From the support side…" }
  ]
}
```

Lyra overwrites it on every export, as it does the text file. If the text file changed on disk
since Lyra last wrote it (another editor, an agent), Lyra copies that version to
`.sessions/<id>/external/<timestamp>.<ext>` before overwriting, so nothing is lost while the
export is one-way.

### `session.json`

```ts
type SessionManifest = {
  version: 1
  id: string                 // file stem, e.g. "2026-11-23_10-30-00"
  startedAt: string          // ISO
  endedAt: string | null
  tracks: { name: 'mic' | 'system'; file: string; sampleRate: 16000; seconds: number }[]
  passes: { id: string; kind: 'live' | 'diarized'; createdAt: string; model: string }[]
  audio: 'kept' | 'deleted'  // retention outcome, so the UI can say why playback is missing
}
```

Small, rewritten atomically (temp file + rename, as `settings.ts` does). The list view reads
manifests plus each document's title and tags, never the audio.

### Raw transcript pass

```ts
type RawPass = {
  id: string
  segments: {
    id: string               // stable, e.g. "p1-s042"
    start: number            // seconds into the session
    end: number
    track: 'mic' | 'system' | 'mix'
    cluster: number | null   // diarization cluster, null for live dictation
    confidence: number       // 0–1, voice match for the cluster (drives the UI signal)
    words: { text: string; start: number; end: number; p: number }[]
  }[]
  clusters: { id: number; embedding: number[]; match: { personId: string; score: number } | null }[]
}
```

This is `TranscriptWord[]` (already returned by `whisper:transcribe`) plus what
`diarize()`/`nameSpeakers()` compute today and then drop. Nothing here is ever edited, so "show
original", re-running a better model, or diffing an edit against what was heard is always
possible.

### The Yjs document

```
Y.Doc
├─ meta: Y.Map
│   ├─ title: string
│   ├─ tags: Y.Array<string>
│   └─ speakers: Y.Map<clusterId, Y.Map { name, personId, confirmed: boolean }>
├─ notes: Y.Text                      ← free writing, dictation lands here, AI notes go here
└─ transcript: Y.Array<Y.Map>         ← one entry per segment, in time order
    ├─ id, rawId                       (rawId → the RawPass segment it came from)
    ├─ start, end                      (seconds; audio playback and the margin timestamp)
    ├─ cluster                         (→ meta.speakers; a per-line reassignment overrides it)
    ├─ text: Y.Text                    ← the user edits this
    ├─ edited: boolean                 (set on the first user edit; shows the "edited" mark)
    └─ userCluster: boolean            (the user chose this line's speaker; later passes keep it)
```

- **Speakers are data, not text.** Renaming Speaker 2 to Sam sets one `Y.Map` field. The
  regex relabel in `pipeline.ts` goes away, and per-line reassignment and Split (from the
  redesign) become small, exact edits.
- **Edits keep their audio.** Each segment keeps `start`/`end`, so an edited line still plays its
  audio. Word-level seek works on unedited segments by reading `rawId`'s words; once a segment is
  edited, seek falls back to the segment's start.
- **Notes and transcript are separate.** The `──── Transcript ────` divider and
  `splitNotes()`/`withNotes()` string surgery go away.

## Why Yjs

- **Concurrent writers, no lost edits.** The live transcriber appends, the pipeline relabels, AI
  notes arrive and the user types, all on the same session. A CRDT merges them. Today the last
  whole-file write wins.
- **Undo that respects authorship.** `Y.UndoManager` with `trackedOrigins: ['user']` undoes the
  user's edits without undoing transcription that arrived in between.
- **Incremental, crash-safe persistence.** Each change is a small binary update appended to
  `doc.yjs`, instead of rewriting the whole file every 400 ms. A crash loses at most the last
  update.
- **Multiple views stay in sync.** The main window, the recording pill and a future second window
  hold replicas of one document.
- **Room to grow without a server.** Sync across devices (`y-webrtc`, or update files in a synced
  folder) and richer editors (`y-prosemirror`, `y-codemirror.next`) plug into the same document
  later. Nothing here sends data anywhere; Yjs is a local library.

Dependency: `yjs` (MIT, about 80 KB, its only dependency is `lib0`). Nothing else is required for
phase 1. `y-protocols`, `y-indexeddb` and the like are not needed because main owns persistence.

## Process ownership

- **Main owns the authoritative `Y.Doc`** per open session (it has the disk). A
  `SessionStore` in `src/main/sessionStore.ts` loads `doc.yjs`, applies updates, appends them to
  disk, and compacts on close (`Y.encodeStateAsUpdate` → rewrite the file).
- **The renderer holds a replica.** It is synced over IPC with
  `Y.encodeStateVector`/`encodeStateAsUpdate` on open, then `session:update` messages each way,
  carrying a `Uint8Array` update and an origin. It follows the four-place rule in the
  `add-ipc-channel` skill. Updates from the renderer are `unknown` until checked as `Uint8Array`
  and applied inside a try.
- **The pipeline, notes generator and live transcriber write to main's doc** with their own
  origins (`'pipeline'`, `'notes'`, `'live'`), not by saving text.
- **The export file** is re-rendered from the document, debounced (about 1 s), and written with
  the existing `markOwnWrite` so the watcher ignores it.

## External edits to the export

**For now the export is one-way.** Lyra writes the text file and the metadata file and doesn't
read edits back. A changed text file is backed up to `external/` before the next export
overwrites it (see above). A *new* text file dropped into the folder still becomes a session, so
creating notes from outside keeps working.

**Future: two-way.** Letting an agent or another editor edit the file directly is a likely next
step, and the model supports it:

1. Parse the changed file with the export's own rules (title line, notes, transcript lines).
2. Diff each part against the last export (stored hash and text), using a minimal Myers diff.
3. Apply the diff as `Y.Text` operations with origin `'file'`, so it merges with anything Lyra
   wrote at the same time. Transcript lines map to segments by order and timestamp; a line that
   can't be matched becomes notes text rather than being dropped.
4. Flip `editable` to `true` in the metadata so readers know edits are honoured.

## Audio capture and retention

- **Record audio for every session**, dictation included. The renderer already streams 16 kHz
  PCM for meetings through `recorder:append`; dictation reuses the same path.
- **Size:** WAV at 16 kHz mono is about 1.9 MB a minute per track (about 115 MB for a one-hour
  call with both tracks). That's acceptable to start with. Opus through `AudioEncoder`
  (WebCodecs, built into Electron) is about 10–20× smaller and needs no dependency; it's a later
  step.
- **Retention** replaces "Keep meeting audio" with a setting: *Keep audio: Always / for N days
  / Delete after transcription*, **30 days by default**. A sweep on launch and once a day deletes
  expired tracks. The raw transcript and the document are always kept. The manifest records
  `audio: 'deleted'` so the UI can say why a line won't play, and the metadata file drops the
  track and records when it went.

## Migration

One-time, on first launch of the new version, logged, never destructive:

- **Plain notes** (`*.txt`/`*.md` with no sidecars) get a session folder with a manifest, no
  tracks and no passes. The document gets `title` and `notes` from the file, and an empty
  transcript. The export is byte-identical, so nothing changes for the user.
- **Labeled meetings** (`.meta/<stem>.json`): parse the `[hh:mm:ss] Name: text` lines into
  transcript segments with `start` from the timestamp, cluster names from `speakers`, and
  `liveTranscript` saved as `raw/live.json`. Move any `.audio/<stem>.*.wav` into `audio/`.
- `.meta/` and `.audio/` are renamed to `.meta.migrated` and `.audio.migrated`, not deleted.

## API changes (`VoicePagesApi`)

| Today | Becomes |
| --- | --- |
| `listPages` → `PageSummary[]` | `listSessions` → `SessionSummary[]` (adds `tags`, `seconds`, `speakers`, `hasAudio`) |
| `getPage` / `savePage` (whole body) | `openSession(id)` → initial update; `sessionUpdate(id, update)`; `onSessionUpdate` |
| `createPage` | `createSession({ startedAt })` |
| `deletePage` | `deleteSession` (moves the folder and export to the OS trash via `shell.trashItem`, which also backs Undo) |
| `assignSpeaker`, `getMeetingSpeakers` | Plain document edits to `meta.speakers` / segment `cluster` |
| — | `sessionAudio(id, start, end)` → PCM for a segment (playback, "Listen") |

Settings, people/voiceprints, updater, hotkeys and the mic watcher are unchanged.

## Phases

Each phase leaves the app working. All four are implemented; notes on where the code differs
from the plan above:

- **One timeline per session.** Recording again in a session appends to the same
  `audio/mic.wav` (and `system.wav`, padded with silence so the tracks stay aligned), so
  transcript times always point into one file. `startRecording` returns where the new recording
  starts.
- **One kind of session.** There is no dictation/meeting switch: every session records the
  mic, plus the computer's audio when that setting is on.
- **Transcribed a chunk at a time, labeled by track, settled when the recording stops.**
  Main transcribes the audio as it arrives (`src/main/transcriber.ts`), each track on its own.
  A track is cut into chunks at pauses, up to Whisper's 30 s window, as WhisperX's "cut and
  merge" does (`src/shared/audio/chunker.ts`); context carries across chunks as Whisper's prompt,
  so chunks never overlap. Silero VAD inside whisper.cpp keeps Whisper to speech. A chunk's text
  is final when it lands, so the window never shows text that might change; until then it shows
  that it's transcribing and how far behind it is. On a call (a system track as well as the mic)
  the remote voice that plays from the speakers into the mic is gated out of the mic track
  (`EchoGate`), and each line is labeled by its track: the person at this computer, or "Remote"
  (`src/main/takeWriter.ts`). Without a system track lines have no speaker until the recording
  stops, and one voice reads as plain paragraphs. Once a recording stops, `meeting/relabel.ts`
  diarizes the whole session's audio and moves each word to the speaker diarized at its time (as
  WhisperX assigns words), keeping mic words with speakers heard on the mic and system words with
  the far end, rebuilding lines by turn. The words stay exactly as transcribed; edited lines keep
  their text; a speaker the user named keeps its name on the diarized voice it shares the most
  talk with. The words are kept in `raw/live.json` (with the track each came from) and the
  relabeled lines as `raw/pass-N.json`, so `pnpm replay:session` can re-run a session that came
  out wrong. `processMeeting` (diarize, then transcribe each turn) remains for
  `pnpm smoke:meeting <file.wav> --offline` and the eval.
- **Notes are only what the user types.** Earlier versions wrote live text into the notes and
  replaced it with the labeled transcript afterwards (`meta.liveRanges`, `removeLiveNotes`); that
  path remains for documents made that way.
- **Generated notes live in `summary`**, a separate `Y.Text`, so "Rewrite notes" never touches
  the user's notes. The export renders summary, notes, then transcript.
- **Per-line confidence** is the cosine similarity between a line's own voiceprint and its
  speaker's. Lines below 0.6 are flagged and pre-ticked in Split.
- **A re-run keeps edits**: a new pass replaces the transcript, but a line the user edited keeps
  its words, and the raw words its edits were made over, when the new pass has a line over the
  same stretch of audio.
- **The transcript is locked; edits are an overlay.** A segment's `original` is never changed
  once written. The user's changes are `edits`: `replace` (a correction), `delete` (struck
  through but still shown) and `highlight` ranges over `original`
  (`src/shared/transcriptOverlay.ts`). `text` is derived from them and kept in the document, so
  the export and other readers needn't apply the overlay. The window has no text field on a
  line: edits come from the selection toolbar and the right-click menu, "Raw" shows exactly what
  was heard, and each action is its own undo step. The metadata file lists a line's `edits`.
- **Notes are markdown in a rich editor.** The window edits `notes` with Tiptap and writes it
  back as markdown, so the export stays plain text. The notes sit above the transcript in their
  own pane.

1. **Session store and Yjs document.** Add `sessionStore.ts` (manifest, `doc.yjs` log and compaction,
   export rendering), migration, and the IPC sync. Plain notes only: `notes`, `title`, `tags`.
   The renderer editor binds `notes` to a `Y.Text` (textarea diffing is enough for now; a rich
   editor binding comes later). Smoke cases go in `runUiSmoke`: create, edit from two origins,
   reopen, export matches.
2. **Raw capture for every session.** Always record audio; write `raw/live.json` from the
   streaming transcriber's committed words; add retention.
3. **Meeting pipeline on the document.** `processMeeting` writes a `RawPass` and fills
   `transcript` and `meta.speakers`. Delete `relabel`, `splitNotes` and the divider. Add the
   external-edit merge.
4. **Editable transcript UI.** The redesign's margin speakers and confidence, per-line and
   whole-speaker reassignment, Split with Undo, "edited" marks and "Show original", and Listen
   on a segment.

## Open questions

- **Export format for the transcript**: keep `[hh:mm:ss] Name: text`, or switch to
  `Name (00:02): text`? It only affects readability in other editors.
- **Two-way export**: when to turn it on, and whether agents should edit the text file or write
  through a small API (the Yjs update channel) instead.

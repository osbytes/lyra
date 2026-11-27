# Session data model

Status: implemented (2026-11-23), phases 1–4. Replaces the page model in
`apps/lyra/src/main/pages.ts` and the meeting sidecars in `.audio/` and `.meta/`. The document
was a Yjs CRDT until 2026-11-26; it is now plain data owned by main (see
[Why plain data](#why-plain-data)).

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
| **Document** | What the user sees and edits: title, tags, notes, transcript, speaker names | Fully editable, through main | `doc.json` |

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
    checkpoint/diarize.json                ← a long step's work so far, until it finishes (derived)
    doc.json                               ← the editable document
    doc.yjs.migrated                       ← the document as Lyra 0.6 and earlier kept it (Yjs), once migrated
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
  pending: ('transcribe' | 'speakers' | 'notes')[]  // steps a recording still owes, until they end
}
```

### Resuming interrupted work

A quit or crash part way through a session's work is picked up at the next start
(`src/main/resume.ts`), one session at a time:

- **Only what's owed is read.** Startup looks at each manifest's `pending` and reads nothing else
  of a session that owes nothing. An unreadable `live.json` is left where it is and its step stays
  owed.
- **Transcription.** `pending` gets `transcribe` when a take starts, and the take's stop clears it
  once all of its audio is transcribed. While recording, `raw/live.json` is saved every few
  seconds with an `untranscribed` mark per track, open-ended, from where the words handed out so
  far end (from the take's start before the first words). A quit that can't wait for Whisper
  leaves closed marks. At the next start the marked audio is transcribed again from
  `audio/*.wav`, with the words heard just before it as Whisper's prompt, and only the words after
  each mark are kept. Recovered words are always relabeled, even if the speakers were already
  settled. Without a relabel they're added as lines where no line of their track covers them yet.
- **Speakers and summary.** `pending` gets `speakers` when a take starts. Relabeling swaps it for
  `notes` when it finds speakers, and writing the summary clears that. A step that fails is
  cleared too, since retrying it at every launch would only report it again. A step cut off by the
  quit itself stays owed.
- **Checkpoints.** The long steps keep what they have done in `checkpoint/`: the whole
  recording's diarization, keyed by the audio's length, the words and the settings, and each
  answer the notes model gave, keyed by prompt and writer. A retry reuses what matches, and each
  file is deleted once its step is done. They're kept apart from `raw/`, where every file is a
  pass.
- **Downloads** resume from their `.part` file once a step needs the model again.

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

### The document (`doc.json`)

One zod schema, `SessionDoc` in `src/shared/sessionDoc.ts`; the file is that object plus a
`version`. It's rewritten whole (atomically, like the manifest, without blocking the main
process) once changes pause for a quarter second, and at least every second while they don't.

```
SessionDoc
├─ title, summary, notes: string      ← notes are the user's markdown; summary is generated notes
├─ tags: string[]
├─ speakers: { id, name, personId, confirmed, confidence, matches }[]
├─ transcript: segment[]              ← one per line, in time order
│   ├─ id, rawId                       (rawId → the RawPass segment it came from)
│   ├─ start, end                      (seconds; audio playback and the margin timestamp)
│   ├─ cluster                         (→ speakers; a per-line reassignment overrides it)
│   ├─ original                        what the model heard; never changed once written
│   ├─ edits, text, edited             the user's overlay over `original`, and its result
│   └─ userCluster                     (the user chose this line's speaker; later passes keep it)
├─ speakerSeq                          the next free speaker number, only ever raised
└─ notesGenerated, notesRun            the last generated summary's fingerprint, and how it was made
```

- **Speakers are data, not text.** Renaming Speaker 2 to Sam sets one field. Per-line
  reassignment and Split are small, exact edits.
- **Edits keep their audio.** Each segment keeps `start`/`end`, so an edited line still plays its
  audio. Word-level seek works on unedited segments by reading `rawId`'s words; once a segment is
  edited, seek falls back to the segment's start.
- **Notes and transcript are separate.** The `──── Transcript ────` divider and
  `splitNotes()`/`withNotes()` string surgery went away; they're only read when migrating.

## Process ownership

- **Main owns the document** of every open session (`src/main/sessionStore.ts`). Every change is
  a function run on a copy of the committed document, which is then committed whole: a writer
  that throws leaves the session as it was. Each commit counts up the session's `rev`, saves the
  file, schedules the export, and sends every window that holds the session the top-level fields
  that changed (`sessions:changed`).
- **Windows send edits, not state.** An edit is a `SessionOp` (zod, validated in main): set the
  title, notes or summary, add or remove a tag, set a line's overlay, move lines to a speaker
  (creating it), name a speaker (merging it into a same-named one), or put back what an undo step
  changed. Each one *sets* a value rather than changing one by an amount, so applying it twice
  does nothing more. `sessions:edit` applies a window's ops in order as one commit and resolves
  to its `rev`; the change event echoes the window's own count (`seq`) back as `ack`.
- **A window shows its own edits at once** (`src/renderer/src/lib/sessionReplica.ts`): main's
  latest state with the edits main hasn't confirmed yet applied on top, dropped as their `ack`
  arrives. A change event whose `rev` skips one means a change was missed, and the window
  reopens the session. Typing never waits on a round trip, and an edit from another window, a
  live line or a summary that lands meanwhile shows beside it.
- **Main-process writers** (live transcription, relabeling, notes, speaker naming) call
  `editSession`/`changeSession` with a function of the document. It runs synchronously, so a
  check and the write it guards can't be split by another edit: notes check `mayWriteSummary`
  against the summary as it is at that moment, and relabeling checks that the lines it diarized
  are still the session's before replacing them. The user's own choices are data the passes
  respect (`userCluster`, `edited` lines, `confirmed` speakers), not authorship of a change.
- **Undo** is per window and per session. Each step is a `SessionPatch`: what an edit changed,
  from and to, for the title, summary, tags, speakers and lines it touched. Undo sends the
  patch back (`restore`), and each part is put back only where the session still holds what the
  edit left, so undo never takes back a live line, a relabel or another window's edit that came
  after. Quick typing in the title or summary merges into one step. The notes editor (Tiptap)
  keeps its own history, which knows the selection, so notes aren't in these steps.
- **The export file** is re-rendered from the document, debounced (about 300 ms), and written
  with the existing `markOwnWrite` so the watcher ignores it. The search index follows the same
  commits through the store's change events (`onSessionChange`).

## Why plain data

The document was a Yjs CRDT, chosen so the transcript and the notes could one day share one
editor, with concurrent writers merged character by character. They stay separate (the notes are
a Tiptap markdown editor, the transcript its own component), and without that the CRDT was
overhead:

- **Nothing merges inside a string any more.** The notes have one writer at a time (the user's
  editor); the summary is replaced whole by the notes pipeline, behind its edit check; the title
  is a field. Transcript and speaker edits were always whole values on one line or speaker.
- **One process already decides.** Main holds the disk and every machine writer, so it can apply
  changes in order; replicas with their own clocks bought nothing a sequence number doesn't.
- **Undo is simpler as data.** "Put this back if it's still what I left" covers what
  `Y.UndoManager`'s origin tracking did, for the parts undo covers.
- **The files are readable.** `doc.json` can be opened, diffed and read by an agent; `doc.yjs`
  needed Yjs and a frame reader.

What it costs: two windows typing in the *same* notes at the same moment keep the later one's
text (each edit sets the whole field), and a crash loses up to the last second of changes rather
than the last update. Neither happens in practice: one window edits notes at a time, and the
export, the manifest's `dirty` flag and the debounce were already the recovery story.

### Migrating sessions from Lyra 0.6 and earlier

A session folder with `doc.yjs` and no `doc.json` is read once when it's first opened (or listed):
`src/main/legacyYjs.ts` decodes the update log without the `yjs` package (the v1 update format,
Yjs's item ordering for concurrent edits, delete sets, nested maps, arrays and text), checked
against yjs 13.6 on random concurrent histories and on every real log available when it was
written. The document becomes `doc.json` and the log is renamed `doc.yjs.migrated`, never
deleted. A torn log keeps what came before the tear (and a copy, as before); one with nothing
readable is set aside and the document is rebuilt from the export. Live-transcription ranges in
the notes from before transcript lines (`meta.liveRanges`) are dropped: that text stays in the
notes. The search index reads an unmigrated session's log the same way, without migrating it.

## External edits to the export

**For now the export is one-way.** Lyra writes the text file and the metadata file and doesn't
read edits back. A changed text file is backed up to `external/` before the next export
overwrites it (see above). A *new* text file dropped into the folder still becomes a session, so
creating notes from outside keeps working.

**Future: two-way.** Letting an agent or another editor edit the file directly is a likely next
step, and the model supports it:

1. Parse the changed file with the export's own rules (title line, notes, transcript lines).
2. Diff each part against the last export (stored hash and text).
3. Apply the differences as `SessionOp`s from a `'file'` writer, through the same commit path
   as a window. Transcript lines map to segments by order and timestamp; a line that can't be
   matched becomes notes text rather than being dropped.
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
| `getPage` / `savePage` (whole body) | `openSession(id)` → `{ rev, doc }`; `editSession(id, seq, ops)` → `rev`; `onSessionChange` |
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
- **Transcribed a chunk at a time, labeled from the voices as it goes, settled when the recording stops.**
  Main transcribes the audio as it arrives (`src/main/transcriber.ts`), each track on its own.
  A track is cut into chunks at pauses, up to Whisper's 30 s window, as WhisperX's "cut and
  merge" does (`src/shared/audio/chunker.ts`); context carries across chunks as Whisper's prompt,
  so chunks never overlap. Silero VAD inside whisper.cpp keeps Whisper to speech. A chunk's text
  is final when it lands, so the window never shows text that might change; until then it shows
  that it's transcribing and how far behind it is. On a call (a system track as well as the mic)
  the remote voice that plays from the speakers into the mic is gated out of the mic track
  (`EchoGate`). A line is written with no speaker (`src/main/takeWriter.ts`): the track says where
  a sound came from, not who made it (two people share a desk mic, several are on one call), so
  the tracks only keep to separate lines. Every half minute `meeting/liveLabels.ts` diarizes the
  recording so far, the way a finished one is but keeping each round's windows and voiceprints so
  a round costs only the new audio (`meeting/rollingDiarizer.ts`), and gives the lines up to
  there their speakers; what was said since waits for the next round. Once a recording stops, `meeting/relabel.ts`
  diarizes the whole session's audio and moves each word to the speaker diarized at its time (as
  WhisperX assigns words), keeping mic words with speakers heard on the mic and system words with
  the far end, rebuilding lines by turn. The words stay exactly as transcribed; edited lines keep
  their text; a speaker the user named keeps its name on the diarized voice it shares the most
  talk with. The words are kept in `raw/live.json` (with the track each came from) and the
  relabeled lines as `raw/pass-N.json`, so `pnpm replay:session` can re-run a session that came
  out wrong. `processMeeting` (diarize, then transcribe each turn) remains for
  `pnpm smoke:meeting <file.wav> --offline` and the eval.
- **Notes are only what the user types.** Earlier versions wrote live text into the notes and
  replaced it with the labeled transcript afterwards; that text now stays as notes.
- **Generated notes live in `summary`**, a separate field, so "Rewrite notes" never touches the
  user's notes. The export renders summary, notes, then transcript.
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

1. **Session store and document.** Add `sessionStore.ts` (manifest, the document, export
   rendering), migration, and the IPC sync. Plain notes only: `notes`, `title`, `tags`. (Built
   on Yjs at first; plain data since.) Smoke cases go in `runUiSmoke`: create, edit from two
   windows, reopen, export matches.
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
  through a small API (the `SessionOp` channel) instead.

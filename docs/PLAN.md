# Lyra — next features plan

Source: Angel's and Dillon's notes.

## Status (2026-11-20)

All eight PRs are implemented as one stack (`gh stack`, stack #11):

| PR | Scope | Status |
| --- | --- | --- |
| osbytes/lyra#8 | Settings, notes folder, .txt/.md, migration; agent docs + strict TS | Open |
| osbytes/lyra#10 | Timestamped sessions, microphone picker | Open |
| osbytes/lyra#12 | Tray, global hotkey, recording pill | Open |
| osbytes/lyra#13 | "Mic in use" prompt | Open |
| osbytes/lyra#14 | Meeting recording + system audio | Open |
| osbytes/lyra#15 | Speaker labels + voiceprints | Open |
| osbytes/lyra#16 | Meeting notes (local / Claude) | Open |
| PR 8 | Docs, packaging fixes | Open |

Still to validate by hand:
- macOS end to end (menu bar, mic helper, ScreenCaptureKit loopback)
- diarization on real meetings
- Claude notes with a real API key

Decisions made while building:
- **File format:** `.txt` is the default and `.md` is optional; untitled `.txt` notes start with a blank line.
- **New notes:** only hotkey and popup sessions create new files.
- **Meeting notes:** generated locally by default, with Claude as an opt-in.
- **Audio:** deleted after labeling unless "Keep meeting audio" is on.
- **Speakers:** sherpa-onnx, after the diarization spike passed its gate (RTF 0.15–0.25 on synthetic audio).

| Note | Feature |
| --- | --- |
| Save notes as `.txt` in a configurable folder, default `~/.lyra`. "Pick a location to dump files" / "top level directory that can be configured" | **1. Notes folder** |
| File name = session start timestamp | **2. One file per session** |
| "Needs to pick your voice" | **3. Microphone picker** (see open questions) |
| Global hotkey to start a dictation session | **4. Global hotkey + tray** |
| If audio capture is detected, small popup asking to start a session | **5. "Mic in use" prompt** |
| Recognize people's voices, assign names | **6–7. Session audio + speaker labels** |
| Meeting notes | **8. Meeting notes** |

All of these need a settings store, so that ships first. §6–8 build on the per-session files from §2.

## Where things stand today

- Pages are Markdown files with frontmatter, named `<uuid>.md`, under `userData/pages` ([pages.ts](../src/main/pages.ts)). The folder is hardcoded.
- Dictation runs entirely in the renderer ([useDictation.ts](../src/renderer/src/hooks/useDictation.ts)). It always uses the default mic (`getUserMedia` with no `deviceId`, in [capture.ts](../src/renderer/src/audio/capture.ts)).
- The only shortcuts are in-window ones: Ctrl/Cmd+Shift+D to dictate, Ctrl/Cmd+N for a new page ([App.tsx](../src/renderer/src/App.tsx)). There's no tray, and closing the window quits the app (except on macOS).
- No settings or preferences exist anywhere.

---

## 0. Settings foundation

**Main:** new `src/main/settings.ts`
- Stored in `userData/settings.json`. It can't go in the notes folder, because the notes folder is itself a setting.
- Shape:
  ```ts
  type Settings = {
    notesDir: string          // default join(os.homedir(), '.lyra')
    micDeviceId: string | null // null = system default
    hotkey: string            // Electron accelerator, default 'CommandOrControl+Shift+Space'
    micPrompt: { enabled: boolean; ignoredApps: string[] }
    launchAtLogin: boolean
  }
  ```
- `getSettings()` and `updateSettings(patch)` validate the patch, merge it, write atomically (temp file then rename), and emit `settings:changed`.
- IPC: `settings:get`, `settings:update`, `settings:pickFolder` (wraps `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`).
- Add the matching methods to `VoicePagesApi` in [types.ts](../src/shared/types.ts) and [preload](../src/preload/index.ts).

**Renderer:** a Settings view (gear button in the sidebar footer) with sections for Notes folder, Microphone, Hotkey and Prompts.

## 1. Configurable notes folder (`~/.lyra`, plain `.txt`)

Change [pages.ts](../src/main/pages.ts):
- `pagesDir()` reads `settings.notesDir` and creates it if missing.
- Change the format from `.md` with frontmatter to plain `.txt`, so the files are clean in any editor:
  - `body` is the whole file.
  - `title` is the first non-empty line, falling back to the file name. Drop the separate title field, or treat the first line as the title in the editor.
  - `updatedAt` is the file's `mtime`.
  - `id` is the file name without `.txt`.
- `listPages` reads `*.txt` at the top level only. Ignore dotfiles and anything else.
- **Changing the folder:** after picking a new folder, ask "Move existing notes?" with Move / Leave them. Then reload the list. The old folder is never deleted.
- **Migration (one time, on first launch of the new version):** if `userData/pages/*.md` exists, convert each file to `.txt` in `notesDir`. Write the title as the first line and keep the original `updatedAt` as the file name and mtime. Then rename the old folder to `pages.migrated`. Log every step.
- Watch the folder with `fs.watch`, debounced, so files added or edited outside Lyra show up. Optional: can come later.
- Guard every path the renderer sends: resolve it and make sure it's still inside `notesDir`, because ids now come from file names.

## 2. One file per dictation session, named by timestamp

- Use a file-name-safe local timestamp: `2026-11-20_14-03-27.txt` (`:` is illegal on Windows). If that name exists, add `-2`.
- A **session** runs from dictation start to stop.
  - **Started from the hotkey or the popup:** always create a new file named for the start time.
  - **Started from the dock button on an open page:** keep appending to that page, as today. *Open question below.*
- `createPage(startedAt?: Date)` creates the file. The renderer calls it before `dictation.start()` whenever a session is a new one.
- Autosave stays as it is (400 ms debounce). Also flush on stop so the file is complete as soon as a session ends.

## 3. Microphone picker ("pick your voice")

- Renderer: list inputs with `navigator.mediaDevices.enumerateDevices()` (labels only appear after mic permission is granted once). Show them in a Settings dropdown and as a small mic menu on the dictation dock, where the mic name already appears.
- Pass `deviceId: { exact: id }` to `openMicrophone()`. If that device is missing (`OverconstrainedError`), fall back to the default and show a notice.
- Listen for `devicechange` and refresh the list. If the chosen mic is unplugged mid-session, the existing `onLost` path already handles it.
- Optional: a live level meter next to the dropdown. `subscribeLevel` already exists.

## 4. Global hotkey + run in the background

Without a tray the hotkey is far less useful, because closing the window quits Lyra. So:
- **Tray** (`src/main/tray.ts`): icon with Start/Stop dictation, Open Lyra, Open notes folder, Settings, Quit. Closing the window hides it instead of quitting. Quit comes from the tray menu or Cmd+Q.
- **Hotkey** (`src/main/hotkey.ts`): `globalShortcut.register(settings.hotkey, toggle)`. Re-register when the setting changes. If registration fails (taken by another app), show that in Settings.
- **Toggle flow:** main sends `session:toggle` → the renderer creates a timestamped page if one is needed, then calls `start()` (or `stop()`).
  - Dictation lives in the renderer, so the window must stay alive while hidden. Set `backgroundThrottling: false` in `webPreferences` and **don't** show the main window on hotkey use.
  - Feedback while hidden: tray icon switches to a "recording" variant, plus a small always-on-top **recording pill** (frameless window, bottom center) showing a level meter, live text and a Stop button. The popup window in §5 can be reused for this.
- Settings: a "record a shortcut" input that captures keydown and converts it to an accelerator string. Reset-to-default button.
- `app.setLoginItemSettings({ openAtLogin })`, so the hotkey works after a reboot. Off by default.
- Default `CommandOrControl+Shift+Space`. Check it doesn't clash with common IMEs on Windows. Fall back to `Alt+Shift+L` if registration fails.

## 5. "Mic in use — start a session?" popup

Reading of the note: when another app starts using the microphone (a Zoom/Teams/Meet call, a voice memo), Lyra shows a small prompt offering to start a session.

**Meeting prompt (done, on by default):** the narrower version of this, like Wispr Flow's. When a listed call app (Zoom, Teams, Slack, Discord, Webex, GoTo, Skype, RingCentral, FaceTime), any other app that is on the mic and playing sound at once (what a call looks like, so unlisted call apps count too; recorders like OBS are excluded), or a browser showing a meeting site's title (Meet, Zoom, Teams, Slack, Discord, Webex, Jitsi, Whereby) holds the mic for 2 s, the overlay offers **Record** (a new session with the computer's audio) or **Dismiss** (quiet for that app for 30 min). Never while recording; apps already on the mic when Lyra starts are skipped until they let go. It works while the window is closed to the tray, and "Open at login" starts Lyra in the tray. Lists and rules: `src/main/meetingApps.ts` and `meetingDetector.ts`. The any-app prompt below stays as a separate, off-by-default setting.

**Detection (`src/main/micwatch.ts`, platform-specific):**
- **Windows:** WASAPI capture and playback sessions (`IAudioSessionManager2` on each active endpoint, an active session's process name), from a PowerShell helper that compiles a little C# COM interop once and prints on change (`micSessionsWin.ts`). Browser tabs: the browser's front window title (`Process.MainWindowTitle`), read only when a browser takes the mic, matched in memory and never logged. Fallback if the helper can't run: the privacy consent store in `HKCU\…\CapabilityAccessManager\ConsentStore\microphone` (`LastUsedTimeStop == 0` means in use), which recent Windows 11 builds stopped updating (`PersistedInDatabase`).
- **macOS:** a Swift helper. On macOS 14+ it names the apps capturing and playing audio by bundle id (CoreAudio process objects, `kAudioProcessPropertyIsRunningInput`/`Output`); before that only `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input (busy or not, no app). Browser meetings aren't detected: reading other apps' window titles needs the Screen Recording permission.
- **Linux:** `pactl list source-outputs short` (non-empty means in use). Best effort.
- **Exclude Lyra itself:** ignore events while our own dictation is running, and on Windows filter out our own exe path.

**Prompt UI:**
- Small frameless, always-on-top, non-focus-stealing `BrowserWindow` (`focusable: false`, `showInactive()`), placed bottom-right above the taskbar or top-right on macOS.
- Text: "Microphone in use by **Zoom**. Start a Lyra session?" with buttons **Start**, **Not now** and **Don't ask for this app**.
- Closes itself after ~10 s. Cooldown: after a dismissal, don't ask again for the same app until it has released the mic.
- **Start** runs the same flow as the hotkey (§4): a new timestamped file, then recording.
- Settings: on/off toggle (default **off** until it's proven reliable) and a list of ignored apps.

> Caveat: Lyra records **your microphone**, not the other people on a call. Transcribing both sides needs system-audio capture, covered in §6.

## 6. Session audio + system-audio capture

Speaker labeling is far more accurate on a full recording after the session than live, so sessions need to keep their audio.

- **Save audio per session:** `~/.lyra/<timestamp>.txt` gets a sibling `~/.lyra/.audio/<timestamp>.opus`. The renderer encodes with `MediaRecorder` (Opus/WebM) alongside the existing 16 kHz frame pipeline.
  - Setting: keep audio *Always*, *Until processed* (delete after speaker labeling), or *Never* (the default for plain dictation).
  - Setting: a storage cap, shown in Settings.
- **Session type:** sessions are either *Dictation* (today's behavior) or *Meeting* (record audio, capture system audio, run the speaker pass when the session ends). Pick it from the dock, the hotkey (a second hotkey or a modifier) or the §5 popup. The popup defaults to *Meeting*, since another app holding the mic usually means a call.
- **System audio (the other side of a call):**
  - **Windows:** `session.setDisplayMediaRequestHandler` with `audio: 'loopback'`, then `getDisplayMedia` in the renderer. No picker or permission prompt.
  - **macOS:** Electron's ScreenCaptureKit loopback, macOS 13+ only. Needs the Screen Recording permission, so add an onboarding step that explains why. Older macOS gets mic only and Settings says so.
  - **Linux:** capture the PulseAudio/PipeWire `.monitor` source as a regular input device. Best effort.
- **Mixing:** keep mic and system audio as **two tracks**.
  - The mic track is almost always *you*, which is a free speaker hint.
  - The system track holds everyone else.
  - Mix the two down only for the live Whisper pass. Echo cancellation matters when you're on speakers instead of headphones.

## 7. Speaker recognition ("assign people a voice")

Two parts:

1. **Diarization (who spoke when):** split the audio into turns labeled `Speaker 1`, `Speaker 2`, and so on.
2. **Identification (which person):** match each speaker against saved voiceprints of named people.

**Engine:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) via its Node bindings (`sherpa-onnx-node`).
- Pyannote segmentation model plus a speaker-embedding model (3D-Speaker / WeSpeaker ERes2Net, roughly 25–40 MB). All offline.
- Download the models on first use, like the Whisper model, into `userData/models`.
- Runs in main, or better in a `utilityProcess` so a long meeting doesn't block IPC.
- Alternative considered: whisper.cpp's `tinydiarize` only detects speaker *changes*, English only, and is lower quality. Python pyannote is too heavy to bundle.

**People (voiceprints):**
- Settings → **People**: add a person, read a prompt aloud for ~20 s, and store the averaged embedding.
- Stored in `userData/voices.json`: `{ id, name, embeddings: number[][], createdAt }`. It lives in `userData`, not the notes folder, so voiceprints aren't synced or shared by accident. Each person can be deleted.
- Matching uses cosine similarity against each person. A match needs to be above a threshold (~0.6, tuned on test data). Anything below stays `Speaker N`.
- **Learn from corrections:** click a `Speaker 2` label in a transcript, pick "Dillon" or "New person…". That relabels every turn by that speaker in the session and adds the cluster's embedding to Dillon's voiceprint, so it gets better over time.
- On a two-track recording, default the mic track to "Me" (the user's own enrolled voice).

**Pipeline at session end (Meeting sessions):**
1. Diarize the saved audio into speaker turns.
2. Give each turn's speaker a name if it matches a saved person.
3. Re-run Whisper per turn, or align the existing word timestamps (`TranscriptWord` already has start/end) to the turns.
4. Rewrite the session file as a labeled transcript:
   ```
   Meeting — 2026-11-20 14:03
   People: Angel, Dillon, Speaker 3

   [00:00:04] Angel: Okay, let's go through the release.
   [00:00:09] Dillon: I pushed the updater fix last night.
   ```
   Keep the raw live transcript until the pass succeeds, then replace it. If the pass fails, the plain transcript stays.
- Show progress in the UI ("Identifying speakers… 40%"). A 1-hour meeting should take a few minutes on a laptop CPU. Benchmark this early.
- **Live labels (later, optional):** embed each VAD segment while recording and label it against saved people. Lower accuracy. Only do this once the after-session pass works well.

**Privacy/consent:**
- Voiceprints are biometric data in some jurisdictions (e.g. Illinois BIPA, GDPR). Keep them local-only, get explicit consent text when enrolling someone, and make "Delete person" really delete.
- Show a one-time notice on the first Meeting session reminding the user to get consent from people being recorded.

## 8. Meeting notes

Generate notes from the labeled transcript, saved as `<timestamp>.notes.txt` next to it (or at the top of the same file — open question):
- Summary (3–5 sentences)
- Decisions
- Action items as `- [ ] Owner: task`, with owners taken from speaker names
- Open questions

**Model options**, chosen in Settings and off until the user picks one:
- **Local (default):** llama.cpp via `node-llama-cpp` with a small instruct model (3–8B, 2–5 GB download). Fully private, but slower and lower quality on long meetings. A meeting over 20 minutes (or too big for one call) is cut into sections where the topic changes (`meeting/notesSections.ts`), each section is summarized with a recap of the ones before it, items are combined in code, and only the overall summary is written from the sections' summaries (`meeting/notesPipeline.ts`). The summary lists the sections with their start times. Action items get a call of their own per section (the model quotes the words that commit to each, and an item it can't quote is dropped): asked for alongside everything else, a 3B model leaves the list empty. Each session's notes record the pipeline version that made them (`notesRun` in the doc's meta, `NOTES_PIPELINE`), so Settings → Summaries can rewrite untouched notes from an older version, or write notes for meetings that have none.
- **Cloud (opt-in):** Claude API with the user's own API key, stored in the OS keychain via `safeStorage`. Much better notes. Show a clear "this sends the transcript to Anthropic" warning.

Notes can be regenerated, and editing the transcript (e.g. fixing a name) offers to regenerate them.

---

## Suggested order / PRs

1. **Settings + notes folder + `.txt` + migration** (§0, §1). This is the riskiest change because it touches existing user data, so ship it alone with the smoke tests updated.
2. **Timestamped session files + mic picker** (§2, §3). Small, renderer-heavy.
3. **Tray + global hotkey + recording pill** (§4).
4. **Mic-in-use popup**: Windows first, then macOS helper, then Linux (§5).
5. **Session audio + Meeting session type + system audio** (§6). Windows loopback first.
6. **Speaker spike**: before building the UI, run sherpa-onnx diarization on 3–4 real recordings (a 2-person call, a 4-person in-room meeting). Measure accuracy and speed and pick the threshold. If quality is poor, rethink before building §7.
7. **Speaker labels + People/enrollment** (§7).
8. **Meeting notes** (§8): local model first, then the optional Claude API.

## Testing

- Extend [run-ui-smoke](../scripts/run-ui-smoke.cjs) or the in-app `runUiSmoke`: point `notesDir` at a temp folder, create a session page, assert `YYYY-MM-DD_HH-mm-ss.txt` exists with the body, and check that a path-traversal id is rejected.
- Migration test: seed `userData/pages/*.md` in the smoke `userData`, launch, and assert the `.txt` output and the `pages.migrated` folder.
- Manual checklist per OS: hotkey while the window is hidden, unplugging the selected mic mid-session, and the popup triggering from a Zoom/voice-recorder call without triggering on Lyra's own recording.

## Open questions for Angel & Dillon

1. **"Pick your voice"**: probably speaker enrollment (§7). Do we still want the plain microphone picker (§3) too? (Recommend yes; it's small.)
2. **"Audio capture is identified"**: another app using the **mic** (as planned). Should the popup default to a *Meeting* session (§6)?
3. **Every session gets a new file?** Or only hotkey/popup sessions, with the in-app record button still appending to the open page?
4. **`.txt` vs `.md`**: are we OK dropping Markdown and the in-file title, so the first line is the title?
5. **"Top level directory"**: one flat folder, or subfolders under it (e.g. by date `~/.lyra/2026-11/…`, or `meetings/` vs `notes/`)?
6. **Meeting notes model**: local only, cloud (Claude API) only, or both with local as the default?
7. **Notes placement**: a separate `<timestamp>.notes.txt`, or a notes section at the top of the transcript file?
8. **Main use case**: mostly online calls (system audio matters most) or in-room meetings around one laptop (diarization quality matters most)?
9. **Keeping audio**: is it OK to keep meeting audio on disk by default, or delete it once processing finishes?

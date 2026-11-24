# lyra

## 0.3.0

### Minor Changes

- [#27](https://github.com/osbytes/lyra/pull/27) [`8644e13`](https://github.com/osbytes/lyra/commit/8644e13a114dacc93885a66f0fcc5c17354cfe4d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New setting, Settings → Meetings → Keep recordings: keep recorded audio until it's transcribed, for 7, 30, 90 or 365 days, or forever.
  
  **Upgrade:** recorded meeting audio is now kept for 30 days by default (it used to be deleted once speakers were labeled, unless "Keep meeting audio" was on; that setting becomes "forever"). Choose "Until transcribed" to keep the old behaviour.

- [#29](https://github.com/osbytes/lyra/pull/29) [`58d2031`](https://github.com/osbytes/lyra/commit/58d20311e54ff4129aa840bbfc1e158ff8132e4e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Meeting transcripts are now editable line by line, with speakers in the margin and a confidence signal for lines that may be someone else. Click a speaker to confirm Lyra's guess in one click, pick from saved voices ranked by match, fix a single line, listen to a clip, or split a speaker who was really two people (with Undo). Generated meeting notes sit in their own section, so rewriting them never touches your notes.
  
  **Upgrade:** dictation now records audio too, kept on this computer for as long as Settings → Meetings → Keep recordings says (30 days by default). Meetings from earlier versions are converted on first launch, and their kept audio moves into the session.

- [#32](https://github.com/osbytes/lyra/pull/32) [`fa67dbe`](https://github.com/osbytes/lyra/commit/fa67dbe6842c5761d4de2587b65a89d83afe2c56) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Speakers are now identified live while you record. Each phrase becomes a transcript line for the person who said it, and the transcript grows at the end of the page. With one voice it reads as plain paragraphs; speaker names appear in the margin once a second person talks. Nothing on the page moves when someone new speaks.
  
  **Upgrade:** There is no longer a "Transcribing / identifying speakers" step after you stop recording, and new recordings no longer write into the notes field: notes are only what you type. Existing sessions are unchanged.

- [#29](https://github.com/osbytes/lyra/pull/29) [`73f49f9`](https://github.com/osbytes/lyra/commit/73f49f9982d6f0398016fe19b8c870eb639791d5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Lyra now has one kind of session. "Continue session" in the dock adds to the open session, and New session (Ctrl+N, the + button or the global shortcut) starts one and begins recording. The dock shows what is being recorded (your mic, plus computer audio) and lets you change it in place. Speakers are labeled automatically when more than one voice is heard; a solo session stays plain notes. Sessions can be tagged, the sidebar filters by tag, and a details side panel (Ctrl+. or the panel button) shows dates, duration, tags, speakers and actions. Every dropdown is now a Lyra menu instead of the system one.
  
  **Upgrade:** the separate meeting shortcut and the tray's "Start meeting" item are gone; the one shortcut (Ctrl+Shift+Space by default) starts a session. Whether the computer's audio is recorded now follows Settings → Meetings → Capture computer audio for every session.

- [#38](https://github.com/osbytes/lyra/pull/38) [`385ffc0`](https://github.com/osbytes/lyra/commit/385ffc0328abb9d4d1102dc582fa539e327d5ad5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Press Ctrl+K (⌘K on macOS) to search everything: session titles, tags, notes, meeting notes and every transcript line, with typo-tolerant matching. Results show where the words matched (and who said them, and when), a preview of the session, and quick commands; opening a transcript match jumps to that line.
  
  New sessions are named for when they started ("Monday morning"), and once you've recorded, Lyra suggests a better title from what was said, using the meeting-notes engine you chose. A title you typed yourself is never replaced.
  
  Speakers get their own pastel colour, the same everywhere in a session. The recording bar is smaller and cleaner, and you can drag it anywhere in the window.

- [#27](https://github.com/osbytes/lyra/pull/27) [`ef080b1`](https://github.com/osbytes/lyra/commit/ef080b1cb37da08f5b756745196b3ef95f3557cf) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Each note is now a session that merges edits from every source (your typing, meeting labeling, generated notes) instead of the last save winning, and Ctrl+Z undoes only your own edits. A `.lyra.json` file beside each note describes it for scripts and agents.
  
  **Upgrade:** on first launch Lyra creates a hidden `.sessions` folder in your notes folder and a `.lyra.json` beside each note; your note files are not changed. From now on Lyra writes the note file from the session: edits made to it in another editor are kept as a backup copy in `.sessions/<note>/external/` but not read back yet.

- [#35](https://github.com/osbytes/lyra/pull/35) [`cdb18f7`](https://github.com/osbytes/lyra/commit/cdb18f7b633b68dfcfdac5dbe3e44d78b4e02fcc) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Notes and transcript are separate again: your notes sit on top in a rich-text editor (headings, lists, quotes, links; saved as markdown), and the transcript sits below in its own pane, with speakers, that you can resize.
  
  The transcript is now locked to what was heard. Select words to correct, remove or highlight them, or add them to your notes as a quote; right-click a line to edit it, change who said it, listen, copy or restore it. Edits are drawn over the raw words (removed words stay visible, struck through), "Raw" shows exactly what was heard, and Ctrl+Z undoes each edit in turn.

- [#25](https://github.com/osbytes/lyra/pull/25) [`b662c6f`](https://github.com/osbytes/lyra/commit/b662c6f7e2f6944e26c985468c9386dd966266b5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A cleaner, more readable interface: pages grouped by day in the sidebar, deleting a page offers Undo instead of a confirmation, a clearer first-run screen, a Meeting button next to Dictate, and Settings split into General, Recording, Meetings and People with switches. Text contrast now meets WCAG AA in light and dark mode.

- [#39](https://github.com/osbytes/lyra/pull/39) [`2a40e00`](https://github.com/osbytes/lyra/commit/2a40e0034f95f5aee7332b9a2286ff7c82a51d5f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Everything can be undone: Ctrl+Z (⌘Z) brings back a deleted session or saved voice, a renamed person, a changed setting, or a named speaker, and Ctrl+Shift+Z redoes it. Deleting a session or a voice asks first, and a toast offers Undo afterwards. Deleted sessions go to the system trash when Lyra quits.
  
  Right-click menus work the same everywhere: sessions in the sidebar, transcript lines, speakers, tags and people, plus cut, copy, paste and spelling suggestions in text fields. Hints are proper tooltips that also show for keyboard focus, with their shortcut.
  
  Settings are grouped as General, Sessions and People, and "meeting notes" are now session summaries. When a setting stops something from working (the shortcut is taken by another app, or Claude summaries have no API key), a red dot marks the Settings button and the tab that fixes it. Copying shows a confirmation.

### Patch Changes

- [#31](https://github.com/osbytes/lyra/pull/31) [`6e1ec6a`](https://github.com/osbytes/lyra/commit/6e1ec6ac7b29459bdabbb79c909507a03a0a0704) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Listen buttons now toggle: press again (or start another clip) to stop playback. Scrolling areas use slim Lyra scrollbars instead of the system ones. Naming a speaker the same as another one (or as the same saved person) now merges them into one speaker, and naming someone whose voice is already saved reuses that voice instead of creating a duplicate.

- [#37](https://github.com/osbytes/lyra/pull/37) [`00215f9`](https://github.com/osbytes/lyra/commit/00215f96d6f6fa7aad5e52691e808e44384d3337) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra checks for updates at its current home on GitHub (osbytes/lyra) instead of relying on the old address redirecting there.

- [#21](https://github.com/osbytes/lyra/pull/21) [`38fb159`](https://github.com/osbytes/lyra/commit/38fb159eb5720023732566c168235d01759997b8) Thanks [@adavila0703](https://github.com/adavila0703)! - Security hardening: upgrade Electron to 42 and patch vulnerable dependencies, only open http(s) links externally, and block the app window from navigating away from its own page.

- [#31](https://github.com/osbytes/lyra/pull/31) [`58fb59b`](https://github.com/osbytes/lyra/commit/58fb59b40218de8f49b0488f25d7fa9d3dd5a922) Thanks [@dillonstreator](https://github.com/dillonstreator)! - You can keep typing while Lyra transcribes: live text now arrives at its own cursor (shown as a labeled "Lyra" caret) instead of moving yours, and Ctrl+Z undoes only what you typed, never transcribed words.

## 0.2.0

### Minor Changes

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Meeting notes: a summary, decisions, action items with owners and open questions are written above the transcript. They are generated on your computer by default, or with Claude if you opt in under Settings > Meeting notes. Only the "With Claude" option sends meeting text off your computer. It is off until you choose a mode.
  
  **Upgrade:** the on-device model is downloaded the first time you generate notes.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Record meetings with your microphone and your computer's audio (Ctrl/Cmd+Shift+M, the tray, or the microphone prompt). Lyra creates a "Meeting" note with a live transcript of both sides. Audio is deleted after the meeting unless you choose to keep it in Settings > Meetings.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra can offer to start a note when another app starts using your microphone. It is off by default; turn it on in Settings > Prompts, where you can also ignore specific apps.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Settings and a configurable notes folder. Notes are plain `.txt` or `.md` files in `~/.lyra` by default, named for the time you started them, and edits made outside Lyra show up in the app.
  
  **Upgrade:** notes from earlier versions are moved into the notes folder once, on first launch.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Meeting transcripts now say who spoke. After a meeting, Lyra identifies the speakers on your computer, names them from saved voices, and re-transcribes each turn. Record a voice sample in Settings > People, or name a speaker from the bar on a meeting note to relabel every line. Saved voices are recognized more reliably in later meetings.
  
  **Upgrade:** speaker detection downloads about 32 MB of models the first time you finish a meeting.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Dictation now streams: words appear as you speak, unconfirmed words show as faint ghost text, and punctuation holds up across pauses. The interface got a refresh, including a new sidebar, editor and floating dictation dock.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Start a new timestamped note with Ctrl/Cmd+Shift+N, and pick which microphone to use in Settings or on the dictation dock. If the chosen microphone is unplugged, Lyra falls back to the system default and tells you.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra now runs in the tray or menu bar. A global shortcut (Ctrl/Cmd+Shift+Space by default, configurable in Settings) starts dictating into a new note even when the window is hidden, with a small floating pill that shows the timer and live text. Closing the window keeps Lyra running; quit from the tray. Optionally open at login.

### Patch Changes

- [#7](https://github.com/osbytes/lyra/pull/7) [`a315b1f`](https://github.com/osbytes/lyra/commit/a315b1f22f8941da2c48bcfae4eaf621aa5ea661) Thanks [@adavila0703](https://github.com/adavila0703)! - Dictation no longer goes quiet for several seconds after a short phrase, and finished sentences appear right away instead of waiting for a pause or getting cut off mid-sentence.

- [#18](https://github.com/osbytes/lyra/pull/18) [`ca22550`](https://github.com/osbytes/lyra/commit/ca22550ac5cd2ce72796c88143c37151eff375a8) Thanks [@adavila0703](https://github.com/adavila0703)! - Meeting transcripts no longer list a phantom extra person for a word or two of speech; speakers with under two seconds of audio are folded into the closest-sounding real speaker.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Live transcription no longer stops partway through a recording after a pause.

- [#20](https://github.com/osbytes/lyra/pull/20) [`75b448c`](https://github.com/osbytes/lyra/commit/75b448cfe54028d261e811cd966963176fa3c34a) Thanks [@adavila0703](https://github.com/adavila0703)! - Untitled `.txt` notes no longer turn their first line into the title.

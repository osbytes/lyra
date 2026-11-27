# lyra

## 0.7.0

### Minor Changes

- [#81](https://github.com/osbytes/lyra/pull/81) [`7c831d2`](https://github.com/osbytes/lyra/commit/7c831d2734fe238fb7071feff8c8e1953a952d65) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Long work now stays findable wherever you are. Model downloads, summaries, speaker labeling, bulk summary rewrites and updates show in an Activity list at the foot of the sidebar, or behind a button in the top bar when the sidebar is hidden. A finished task you weren't looking at gets one toast, and a failure stays, with Retry, until you deal with it. Closing Settings no longer hides a download or loses a bulk rewrite's result, and a session whose summary failed is marked in the list.

- [#86](https://github.com/osbytes/lyra/pull/86) [`6cfe5dc`](https://github.com/osbytes/lyra/commit/6cfe5dc6a6dc7c72863b0abb64dfef77225ceef8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A new look and layout throughout, from the Lyra interface system. Lyra opens on Home, a dashboard of the week: sessions and recorded time against the week before, recorded time per day, what needs you, recent sessions and tags. A meeting reads as panes side by side: the transcript, with sticky section headings and a menu of its sections, and your notes above the speakers and the summary. The speakers share one timeline you can hover, click or right-click to play, jump, step through someone's turns or name them. Press play on any line to play on from there, with a player bar to pause and seek. Record, Record more and Stop sit in the session's header, and a work rail under the title shows recording, quiet levels for the mic and computer audio, and processing. Adding a line or section to your notes puts a compact reference there that jumps back to it, and every jump outlines where you landed. ⌘K also finds Preferences pages, quick toggles, microphones and saved voices. Activity moves to a status bar at the bottom. Narrow windows get the library as a drawer, and down to 320 px a single column with tabs. The details panel and the floating recording dock are gone, and summaries are no longer edited by hand. Also new: IBM Plex Sans and Literata, a high-contrast theme, speaker badges that differ by shape as well as colour, and a compact density in Preferences.

- [#81](https://github.com/osbytes/lyra/pull/81) [`08dfe10`](https://github.com/osbytes/lyra/commit/08dfe10654af8639e13146e649bee32b95983438) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings now shows how a model download is going under the setting that needs it: "Search by meaning" shows the download (with Cancel), then how many passages of your sessions it has read, then Ready; on-device summaries start downloading their model when you pick them, so the first summary doesn't wait. A failed or cancelled download says so, with Retry.

- [#92](https://github.com/osbytes/lyra/pull/92) [`1f898db`](https://github.com/osbytes/lyra/commit/1f898dbd54655bc5a6f15ea9e34318cdd7371dfd) Thanks [@adavila0703](https://github.com/adavila0703)! - People now sits under Home: a list of everyone with a saved voice, with how many sessions they were heard in, how long they talked, their share of the talking and when they were last heard, sortable by each. Each person has a page of their own with their talk time week by week, their sessions, who they are often in sessions with, their action items and the tags of the sessions they spoke in.

- [#94](https://github.com/osbytes/lyra/pull/94) [`9ace692`](https://github.com/osbytes/lyra/commit/9ace692729bd32786502a3523ec68dcd21c0475c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Work a quit or crash cuts short now picks up where it stopped the next time Lyra starts. A recording's words are saved every few seconds, and any audio that wasn't transcribed yet is transcribed from the saved recording. Speakers are then settled and the summary written, as they would have been. Long steps keep what they had already done: a diarized recording isn't diarized again, and a long meeting's summary only asks the model for the parts it hadn't answered yet. Downloads already resumed from where they stopped.

- [#80](https://github.com/osbytes/lyra/pull/80) [`aae84f4`](https://github.com/osbytes/lyra/commit/aae84f4252211a9c0c0686a04b50c3c479aaa2f7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Long meetings get notes by section: the transcript is cut where the topic changes, each section is summarized with a recap of the ones before it, and the summary lists the sections with their start times. Action items get a pass of their own, so the on-device model finds them instead of leaving the list empty, and items from every section are kept without repeats. Each session now records how its notes were made, and Settings → Summaries offers to rewrite notes made by an earlier version (never ones you edited) or to write them for meetings that have none.

- [#84](https://github.com/osbytes/lyra/pull/84) [`532cbaf`](https://github.com/osbytes/lyra/commit/532cbafa9a7f7c77096e2eeeb5388a85d95bbccd) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A long meeting's sections now sit beside the transcript as a table of contents that stays in view and jumps straight to each topic, folding into the transcript bar when the window is narrow. The summary folds to its first lines and a count of decisions, action items and questions, and Rewrite lives on the summary itself. Summaries call people by name instead of guessing pronouns. The title stays at the top while you scroll, and is suggested again after a summary unless you named the session yourself. Sessions show when they started apart from when they were last edited, and the sidebar lists them by date created, with a button to sort by last updated instead.

- [#93](https://github.com/osbytes/lyra/pull/93) [`97d1a42`](https://github.com/osbytes/lyra/commit/97d1a42e6fe02d990b44de8b609e5178f41c89d1) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Send a session, a transcript line or selected text to Claude, Claude Code, ChatGPT, Cursor, Zed, GitHub Copilot or T3 Code with "Send to…" in the right-click and session menus. Only the apps you have installed are listed, with their own icons, and each opens with the text ready in its prompt box for you to send. For a session, tick what to include (the transcript, the summary, sections, decisions, action items, open questions, your notes); Lyra remembers the choice. Every right-click menu item now has an icon.

- [#89](https://github.com/osbytes/lyra/pull/89) [`ecc6b5e`](https://github.com/osbytes/lyra/commit/ecc6b5e6f448a57c4ba57bd3f063538211205009) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Part of a transcript line can now be given to someone else: select the words, choose Speaker…, and pick who said them. The line splits around those words, a later relabel keeps them with that person, and undo puts the line back together.

### Patch Changes

- [#88](https://github.com/osbytes/lyra/pull/88) [`ef5435b`](https://github.com/osbytes/lyra/commit/ef5435b016fae1552f1f2cc9b84d7373680f9a88) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The larger speaker model works on Windows: labeling with it no longer fails with "The operating system cannot run %1". If it ever can't start on your computer, speakers are labeled with the standard model instead, and Activity says so, with Retry and "Use the standard model".

- [#95](https://github.com/osbytes/lyra/pull/95) [`27def98`](https://github.com/osbytes/lyra/commit/27def9886e74c76e675f0233f0cac22e65a21dea) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A speaker you name while recording is now saved as a person: it shows in People and is recognized in later sessions. The speaker picker groups its suggestions into voices that sound alike, people already in the session, and other saved voices, and no longer preselects an unlikely match. After you set someone on a single line, Lyra offers to label that speaker's other lines too.

- [#85](https://github.com/osbytes/lyra/pull/85) [`52f6f06`](https://github.com/osbytes/lyra/commit/52f6f06cff7a1039ed17d808c8002d40b4168f9f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Summaries written on your computer no longer fail on long meetings with a JSON error. The local model now keeps each part of the notes to a sensible length, tries once more if an answer still runs too long, and says it ran out of room if that fails too.

- [#96](https://github.com/osbytes/lyra/pull/96) [`8019277`](https://github.com/osbytes/lyra/commit/8019277182cc757654fe3ab6657e57ae4664e496) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The speaker picker shows each person with the same badge as the timeline and transcript, and stays fully on screen in a short window.

- [#87](https://github.com/osbytes/lyra/pull/87) [`2f95a88`](https://github.com/osbytes/lyra/commit/2f95a88b237885f28de06af3c77320e5dbacefa5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sessions are now kept as plain JSON (`doc.json` in the session folder) instead of a Yjs document. Existing sessions move over the first time they're opened, with their notes, summary, transcript, speakers and tags intact; the old file is kept beside it as `doc.yjs.migrated`.

- [#90](https://github.com/osbytes/lyra/pull/90) [`e446367`](https://github.com/osbytes/lyra/commit/e446367f6b8ef4da44fa0fb2d5f6795ec6dbd0c5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Recording reads the same in the window and in the floating pill. While you record, the session's Record button becomes a soft red capsule holding Stop, the time and one meter; the pill is that capsule on its own, smaller, and opens Lyra when clicked. Stop's ring grows with your voice in place of a pulsing dot and a "Listening" label. The mic and computer audio share the meter: your mic in grey, the call drawn over it in teal, so you can see who's talking. The meter no longer turns amber on ordinary loud speech.

- [#83](https://github.com/osbytes/lyra/pull/83) [`07b4906`](https://github.com/osbytes/lyra/commit/07b490645e89ce9ee1712dc7aad894dfeb7fa3e9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A summary being written in one session no longer shows as being written in every session you open, and Stop now stops the right one.

- [#91](https://github.com/osbytes/lyra/pull/91) [`bb8fc41`](https://github.com/osbytes/lyra/commit/bb8fc4134b3338bd84ddc85afdbed7ba19f6f396) Thanks [@adavila0703](https://github.com/adavila0703)! - Calls are recorded on Windows 11 even when your headset or speakers are set to surround sound (7.1), where Lyra used to record only your microphone. Computer audio is now taken from every app but Lyra, on whichever device it plays. When computer audio can't be recorded, Lyra tries again and says so with a Retry button, and the speaker meter dims, instead of quietly recording your microphone only.

## 0.6.0

### Minor Changes

- [#77](https://github.com/osbytes/lyra/pull/77) [`f3c92ce`](https://github.com/osbytes/lyra/commit/f3c92ce734f19cce2535283f83cf499877ac2dd7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New "Larger speaker model" setting (Recording): a larger model works out who spoke when, while you record and once the session ends, and the names you see while recording no longer change afterwards. In meeting rooms with several people it finds the right number of speakers far more often and gives about half as many words to the wrong person. Off by default; turning it on downloads 121 MB. Not available on Intel Macs.

### Patch Changes

- [#74](https://github.com/osbytes/lyra/pull/74) [`a78815c`](https://github.com/osbytes/lyra/commit/a78815c36823070fe0fece12812b883f2e14bd5a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Undo confirmations, recorder notices and errors, and finished or failed processing can now be closed from their toast.

- [#75](https://github.com/osbytes/lyra/pull/75) [`cc3b1aa`](https://github.com/osbytes/lyra/commit/cc3b1aa0a37608ca3a695b89d6a3efc0ef8da847) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra has a new icon: a single bright star on the night sky.

- [#72](https://github.com/osbytes/lyra/pull/72) [`a531212`](https://github.com/osbytes/lyra/commit/a5312127f43bc13ef207008ec33d5c6bbe362efd) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Messages now stack in the bottom-right corner, apart from the record dock, so nothing moves the dock or its button: Undo confirmations, model downloads, recorder notices, and a session's processing, which shows how long is left. The dock's status keeps one width from Listening to Transcribing, and the sidebar marks sessions still being processed.

- [#76](https://github.com/osbytes/lyra/pull/76) [`672ce4e`](https://github.com/osbytes/lyra/commit/672ce4e6b7a82926840aabffe35b8b48b45c8af9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The first and last words of a turn now stay with the person who said them. When two people traded short remarks, Lyra often gave a word or two at each change to the other speaker; it now looks for the exact point where the voice changes and moves it to the pause or sentence end beside it.

## 0.5.0

### Minor Changes

- [#63](https://github.com/osbytes/lyra/pull/63) [`d3abddb`](https://github.com/osbytes/lyra/commit/d3abddb118654213c02e836ee15d52afca97c042) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clearer transcripts in rooms and on calls. Lyra now tells speech from music, fans and typing with a speech-detection model, removes your speakers' sound from the microphone with an echo canceller, and records the microphone without the browser's processing, which cost accuracy. Settings → Recording has a transcription language (your system language by default, or detect automatically), and the filter for phrases Whisper invents in silence now works in every language. A Bluetooth headset in call mode shows a notice, and computer audio reconnects when the output device changes.

- [#66](https://github.com/osbytes/lyra/pull/66) [`3ea3220`](https://github.com/osbytes/lyra/commit/3ea322007e10d774cf8c457a0646fead7572b23d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sturdier recordings and sessions. A crash, a failed or interrupted model download, or opening your notes with an older or newer version of Lyra no longer loses a recording or damages a session. Saved voices no longer learn from Lyra's own guesses, so one wrong match can't make the next one more likely, and a speaker you assign by hand stays assigned. Summaries can now come from a server on your own computer (Ollama, LM Studio) as its own choice in Settings, with a test button; a summary you edited is never rewritten without asking. Settings gains an About tab (versions, storage, copyable diagnostics), permission status, a custom vocabulary for names and jargon, and a confirmation before lowering "Keep audio" deletes recordings. The transcript can be used from the keyboard. Intel Macs now get their own download.
  
  Things to know when updating: saved voices move to a new file format that older versions of Lyra can't read; a summaries server address that uses plain `http://` to another computer is cleared (use `https://`, or a server on this computer); and the search index is rebuilt once, so meaning-based search takes a little while to catch up.

- [#64](https://github.com/osbytes/lyra/pull/64) [`95ba791`](https://github.com/osbytes/lyra/commit/95ba79128e8b093cbb8912d2aba4073d7a807f1b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Lyra now offers to record when a call starts: in Zoom, Teams, Slack, Discord or another call app, or in Google Meet and other meeting sites in your browser. A small card asks whether to record, and Record captures the call's audio as well as your mic. It works while Lyra is closed to the tray, and "Open at login" now starts Lyra there. It checks on this computer only. Turn it off in Settings → Prompts, where you can also add apps Lyra shouldn't ask about, and import or export that list.
  
  On Windows, "Offer a session when the mic turns on" works again on recent Windows 11 builds, which stopped reporting mic use the way Lyra used to read it.

- [#62](https://github.com/osbytes/lyra/pull/62) [`a55213b`](https://github.com/osbytes/lyra/commit/a55213be602aa6f9adfdcd0fcfb15d663a6fc9f1) Thanks [@adavila0703](https://github.com/adavila0703)! - Settings has a Performance tab: graphs of the CPU and memory Lyra has used over the last 30 minutes, with the peak and when it happened, and a breakdown by process (Lyra and Whisper, windows, speaker detection, local summaries, search index, graphics). Lyra takes a reading every 5 seconds from launch, so the graphs cover time when Settings was closed.

- [#58](https://github.com/osbytes/lyra/pull/58) [`4b5ccd4`](https://github.com/osbytes/lyra/commit/4b5ccd4f2925c73396b8a3334af60fc5a3780f98) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Drag the edges of the sidebar and the details panel to size them, up to a maximum that leaves the page room; Lyra remembers the widths. Drag either one past its narrowest width to close it, or drag the edge back out from the window's side to reopen it. The sidebar also has a button in the top bar and Ctrl/Cmd+\ to show and hide it. The transcript bar snaps the same way: drag it close to the top or bottom to close the notes or the transcript.

- [#56](https://github.com/osbytes/lyra/pull/56) [`4b1c9a8`](https://github.com/osbytes/lyra/commit/4b1c9a8031d56e032e36c6cbe209e6b0e760cf6c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A cleaner session page. The title sits in the window's top bar beside Copy and wraps when it's long, and on Windows the window buttons share that bar instead of a separate title bar. The transcript's header is now the divider: drag it, or use its buttons to collapse the transcript or give it the whole page. Generated summaries read as a summary with checkable action items, with Edit for the text. The details panel runs the full height of the window, the sidebar scrolls with Settings always visible, and Settings → People has tidier rows. The Edited/Raw switch is gone; restore an edited line from its right-click menu.

- [#70](https://github.com/osbytes/lyra/pull/70) [`91e8fac`](https://github.com/osbytes/lyra/commit/91e8fac17488d40541f4c0896dfa7500fb589fb9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Speakers are now told apart by their voices while you record, not after. Lines appear without a name and get one within about half a minute, once Lyra has compared the voices, including two people sharing your microphone or several on one call. Lyra no longer labels a line as you just because it came from your microphone.

### Patch Changes

- [#71](https://github.com/osbytes/lyra/pull/71) [`7ee0b0e`](https://github.com/osbytes/lyra/commit/7ee0b0e8ceeb6f2980a43e8a790391daaaf14d62) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Find (Ctrl/Cmd+F) now jumps straight to each match instead of scrolling there slowly, and turning on your system's Reduce motion setting also stops smooth scrolling.

- [#70](https://github.com/osbytes/lyra/pull/70) [`56cbca1`](https://github.com/osbytes/lyra/commit/56cbca125b36011a140b72ddc01cff3f9ac2961f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Two people at one microphone no longer end up as one speaker. After a recording stopped, Lyra heard both voices and then handed every line back to the first speaker, as if you had assigned them yourself; now each voice keeps its own lines.

- [#65](https://github.com/osbytes/lyra/pull/65) [`4c14ce5`](https://github.com/osbytes/lyra/commit/4c14ce59af96c08c8a48b7212d173ddbdc80235c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Calls no longer lose people who only speak briefly. If you said a line or two while remote people did most of the talking, or a second remote person said one sentence, Lyra used to fold them into the main speaker once the recording stopped; now each keeps their own label.

- [#70](https://github.com/osbytes/lyra/pull/70) [`5b92ed1`](https://github.com/osbytes/lyra/commit/5b92ed156ff189e2b561d3852b442aab6524aa66) Thanks [@dillonstreator](https://github.com/dillonstreator)! - "Copy diagnostics" in Settings → About now includes this computer (processor, memory, graphics) and what Lyra and the machine are using right now. The log also records which microphone and output are in use when a recording starts and whenever a device is plugged in or out, to help track down a session that came out wrong.

- [#69](https://github.com/osbytes/lyra/pull/69) [`54c041f`](https://github.com/osbytes/lyra/commit/54c041f90de8bcaac35199864bce6de23ca0670d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The "still processing" status for a session now stays in the transcript's header bar, so it's always in view however far you scroll, and while the transcript is collapsed.

- [#59](https://github.com/osbytes/lyra/pull/59) [`df1870a`](https://github.com/osbytes/lyra/commit/df1870a511b3def09f90dfc4317f2a413537f0b2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The session title is back at the top of the page, with room to breathe, instead of squeezed into the top bar. The Lyra logo moved to the top bar, and search sits at the top of the sidebar. The "Saved" label is gone: notes still save as you type.

## 0.4.0

### Minor Changes

- [#50](https://github.com/osbytes/lyra/pull/50) [`b570675`](https://github.com/osbytes/lyra/commit/b57067586bafa9d6b5d1b7c78514446df183d05b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Recordings are now transcribed a stretch at a time with Whisper large-v3-turbo (a one-time ~575 MB download) instead of streaming draft text that rewrites itself. Lines appear finished, a few seconds after each pause, and the transcript shows that Lyra is listening or catching up instead of half-heard words. On a call, your microphone and the computer's audio are transcribed separately, so your lines are labeled as you and the other side as Remote while you record, and the other side playing through your speakers no longer shows up as you. The dock shows a level meter for each, and warns when your microphone isn't picking anything up. Speakers are still settled from the whole recording when you stop.

- [#51](https://github.com/osbytes/lyra/pull/51) [`4dd2530`](https://github.com/osbytes/lyra/commit/4dd2530ccf2dbbd256aed2b230b870e5d5c37a62) Thanks [@adavila0703](https://github.com/adavila0703)! - Search by meaning: turn it on in Settings → Search and searches also find sessions that say the same thing in other words ("vehicle maintenance" finds "new tires and an oil change"). A small model (about 150 MB, downloaded once) runs on this computer, so nothing leaves it.

- [#51](https://github.com/osbytes/lyra/pull/51) [`ca41c05`](https://github.com/osbytes/lyra/commit/ca41c0566144440a5473e2eeaeb7afc1c503bd87) Thanks [@adavila0703](https://github.com/adavila0703)! - Search runs on the local index: it matches word forms ("budgets" finds "budget"), the start of a word as you type, common misspellings and parts of words, and understands filters: `person:ana`, `tag:design`, `after:2026-11-01`, `before:2026-12`.

- [#51](https://github.com/osbytes/lyra/pull/51) [`8483310`](https://github.com/osbytes/lyra/commit/848331019df8a3fe1742fe96e8e84308615765a3) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra keeps a local search index of your sessions and people (a libSQL database in the app's data folder, never in your notes folder). It's rebuilt from your notes whenever needed and isn't used for search yet; it's the groundwork for searching by speaker, person, tag and meaning.

- [#48](https://github.com/osbytes/lyra/pull/48) [`69c2fec`](https://github.com/osbytes/lyra/commit/69c2fec45cfd1bec87d1403c67942cdc550ffcec) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Lyra tells people apart far more reliably, above all two or more people sharing one laptop mic. It now uses a different voice model (TitaNet, downloaded once, about 40 MB), and after a recording stops it regroups the whole session by voice in a new way. On recordings of real voices in rooms, hybrid meetings and calls, speakers are mixed up about a third as often as before. Saved voices made with the old model can't be compared with the new one, so name yourself once in a session and Lyra recognizes you again from then on.
  
  A saved voice now holds a session together: if one person was split into two speakers and both clearly sound like your saved voice, they become one speaker. Lyra also learns a voice on its own only from a speaker who talked for a while and whom nobody else in the session sounds like, so a wrong guess no longer teaches it the wrong voice.
  
  When you move a line to another speaker, Lyra offers to move that speaker's other lines that sound the same, so one correction fixes the rest.

- [#45](https://github.com/osbytes/lyra/pull/45) [`b5e9b6a`](https://github.com/osbytes/lyra/commit/b5e9b6ae7b7e1175f016c48ceb0f81395b0a5204) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Cloud summaries work with any provider: Anthropic, OpenAI, Google, or your own OpenAI-compatible server (Ollama, LM Studio, llama.cpp), picked with a model in Settings → Sessions. "With Claude" becomes "Cloud model", and an existing Claude setup and key carry over. Keys can also come from the providers' standard variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, plus `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`); a key saved in Settings wins. `HF_ENDPOINT` points model downloads at a Hugging Face mirror, alongside `LYRA_NOTES_DIR` and `LYRA_MODELS_DIR`. A malformed value stops Lyra with a message naming the variable. All variables are listed in docs/CONFIG.md.

### Patch Changes

- [#45](https://github.com/osbytes/lyra/pull/45) [`b5e9b6a`](https://github.com/osbytes/lyra/commit/b5e9b6ae7b7e1175f016c48ceb0f81395b0a5204) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The log file (`lyra.log`) is now one JSON object per line and is written without blocking the app. It never contains note text, transcripts or API keys.

- [#45](https://github.com/osbytes/lyra/pull/45) [`b5e9b6a`](https://github.com/osbytes/lyra/commit/b5e9b6ae7b7e1175f016c48ceb0f81395b0a5204) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Model downloads (Whisper, speaker models and the local notes model) are pinned to one upstream revision and checked against a sha256 hash, so a changed or corrupt file is never loaded. A copy downloaded by an earlier version is checked once and kept if it matches.

- [#45](https://github.com/osbytes/lyra/pull/45) [`b5e9b6a`](https://github.com/osbytes/lyra/commit/b5e9b6ae7b7e1175f016c48ceb0f81395b0a5204) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Quitting while a session is recording now finishes the recording first, so its audio stays playable, and Lyra never waits more than 10 seconds on shutdown work before quitting.

- [#55](https://github.com/osbytes/lyra/pull/55) [`9fe7fb4`](https://github.com/osbytes/lyra/commit/9fe7fb4969cf6a8067ed5cee63d686da0c2e8447) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Recording keeps going while you open other sessions: the dock and the sidebar show which session is recording. Copy works again, Ctrl/Cmd+F finds text in the open session, the sidebar search opens the search palette, restarting a recording no longer adds a duplicate or unclickable speaker, and the floating pill matches the dock.

- [#49](https://github.com/osbytes/lyra/pull/49) [`2630e78`](https://github.com/osbytes/lyra/commit/2630e78cd2b78854cfe5db972e919fb600801a56) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The "What to record" popover no longer turns the whole window into a drag handle for the dock: clicking outside it, clicking its button again or pressing Escape closes it.

## 0.3.1

### Patch Changes

- [#42](https://github.com/osbytes/lyra/pull/42) [`6cea0f9`](https://github.com/osbytes/lyra/commit/6cea0f91de5c8ab1d97dd6b226132f4f5724f90a) Thanks [@adavila0703](https://github.com/adavila0703)! - Updates reach you again. The 0.2.0 and 0.3.0 releases never published their installers, so Check for updates kept offering 0.1.2; 0.3.1 has everything from both.

- [#41](https://github.com/osbytes/lyra/pull/41) [`bb3be08`](https://github.com/osbytes/lyra/commit/bb3be08d734bd34c7e56857f7aef3704823ab3cb) Thanks [@adavila0703](https://github.com/adavila0703)! - Lyra's messages, hints and tooltips no longer use em dashes. A transcript quote added to your notes now ends with a plain `*Name, 0:42*` attribution line.

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

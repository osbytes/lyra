# lyra

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

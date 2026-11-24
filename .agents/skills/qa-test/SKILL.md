---
name: qa-test
description: QA a Lyra change end to end with real audio, not just typecheck and smoke tests. Use for any change to recording, transcription, diarization, speaker labeling, or meeting notes, and whenever asked to "QA", "test with audio", or "try it".
---

# QA test with real audio

`pnpm check` and `pnpm smoke:ui` don't prove audio behavior. Run the real pipeline on a known
recording and compare against what was said.

## Test audio

- Generate it: `powershell -NoProfile -File scripts/make-demo-audio.ps1` writes `test-audio/`:
  `meeting.wav` (16 kHz mono 16-bit, David and Zira alternating, ~46 s) plus `line0.wav`…`line7.wav`
  (one clip per line, even = David, odd = Zira). Regenerate if the folder is missing.
- The script's `$script` array is the ground truth for the transcript and for who spoke each line.
  Edit it to cover a new case (names, numbers, longer turns), then regenerate.
- Only two SAPI voices exist on Windows, so this tests two speakers. It can't stress overlapping or
  noisy speech. Say so in the report; for those, ask the user for a real recording.
- Never commit real user audio. `test-audio/` is synthetic, but keep it untracked unless asked.

## Speaker evals

For speaker, diarization or call-labeling changes, also score the pipeline and compare against a
run from before the change (`eval-data/results/<run>/results.json`):

- `--pipeline live` (the default) replays each scenario as a recording, exactly as the app runs it:
  streaming Whisper, live speaker identification, then the relabel pass after stop. `stream` scores
  live identification alone (what the window shows while recording), `offline` the
  diarize-then-transcribe pipeline. Compare the same pipeline before and after a change.
- `pnpm eval:sessions` (in `apps/lyra`): real people's voices (Mini LibriSpeech, downloaded once,
  decoded with ffmpeg) laid out as conversations, the closest thing to real sessions: two to four
  people at one desk mic at different distances, hybrid meetings with remote people on the system
  track, calls, quick turns, and `room-2-music` with music playing on the computer. Each also has
  `enroll.wav` for testing a saved voice. Start here for speaker changes; `--sessions a,b` runs a
  subset. For clustering or threshold changes, `scripts/eval/cluster-lab.cjs` and
  `scripts/eval/voice-scores.cjs` answer in seconds what an eval run answers in an hour.
- `pnpm eval:calls` (in `apps/lyra`): generated calls with exact ground truth. `call-speakers` has
  the remote voice bleeding into the mic from laptop speakers; `call-speakers-loud` adds a clipped
  system track; `call-quick-turns` / `room-quick-turns` have one-word replies; `call-crosstalk`
  overlaps; `call-similar-voices` / `room-similar-voices` use two voices close enough to merge;
  `room-far-field` / `room-far-similar` are minutes of talk at one reverberant desk mic (a webcam
  in a room) and `call-speakers-long` a long call on laptop speakers, where live voiceprints drift
  together. `--scenarios a,b` runs a subset. Similar-voice scenarios need Windows.
- `pnpm eval:ami --mic Mix-Headset`: real four-person meetings (AMI, CC BY 4.0). Slower; run it
  before merging diarization changes.
- A real session that came out wrong: `pnpm replay:session <id>` re-runs its kept audio (never
  changing it) and prints each pipeline's lines by speaker; its `raw/live.json` `trace` shows each
  live decision (scores against every voice, join/new/reuse, merges). Hand-label a few minutes into
  a reference file to score it with `--reference`. Real audio never goes into the repo.
- Read cpWER (words given to the wrong speaker count as errors) and the speakers found/actual
  column first. Real recordings stay out of `eval-data/` commits and out of the repo.

## Steps

1. Pick the narrowest run that exercises the change:
   - Meeting pipeline (diarization, Whisper, relabeling):
     `pnpm smoke:meeting test-audio\meeting.wav`. Add `--notes local` to include notes and set
     `LYRA_MODELS_DIR=<dir>` to reuse downloaded models (the first run downloads them; say so before
     starting if the models aren't present).
   - Diarization only: `node scripts/diarize-spike.cjs --models <dir> --lines test-audio`
     (alternating speakers A, B, A, … give the ground truth).
   - Live dictation or capture: `pnpm dev`, play `meeting.wav` through the speakers or a virtual
     mic, and watch the transcript.
2. Compare to ground truth, don't just check for "no crash":
   - Transcript matches the script (small word errors are fine; whole lines missing are not).
   - Two speakers detected, and the turns alternate correctly. Count wrong-speaker lines.
   - Notes (if enabled) mention the real action items: the installer bug, the changelog, Sarah's
     update by two.
3. Report: command run, audio used, expected vs. actual (speaker count, line mismatches, any errors
   in the log), and what you couldn't cover (real mics, overlap, noise, other OSes). Failures are
   reported with the output, never rounded to "mostly works".

If a run can't happen (no models, no network, no audio device), say which and why instead of
substituting a weaker check.

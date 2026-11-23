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

## Steps

1. Pick the narrowest run that exercises the change:
   - Meeting pipeline (diarization, Whisper, relabeling):
     `pnpm smoke:meeting test-audio\meeting.wav`. Add `LYRA_NOTES_ENGINE=local` to include notes and
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

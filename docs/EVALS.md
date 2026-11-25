# Evals

How well Lyra transcribes and tells speakers apart, measured on audio with known answers. Public
claims about accuracy quote this file, with its date and sample size, or are not made.

## Suites

| Command (in `apps/lyra`) | Audio | Scores | Needs |
| --- | --- | --- | --- |
| `pnpm eval:sessions` | Real voices (LibriSpeech dev-clean + test-clean, 80 speakers, CC BY 4.0) laid out as conversations: 2 to 6 people at one desk mic in different seats, hybrid meetings and calls with Opus remote audio and speaker bleed, music or a video playing, a fan, backchannels, crosstalk, a speaker who moves, an hour-long meeting when named. Versioned and seeded (`--seeds`); `--enroll` saves the owner's voice first | WER, cpWER, DER, speaker count | ffmpeg; downloads ~690 MB of LibriSpeech once and the models |
| `pnpm eval:calls` | Synthetic calls and rooms made with system text-to-speech: speaker bleed, clipping, quick turns, crosstalk, similar voices | WER, cpWER, DER, speaker count | Windows (SAPI voices) or macOS (`say`, no similar-voice cases); downloads the models |
| `pnpm eval:ami` | Real meetings from the AMI corpus (`--meetings`, `--minutes`, `--mic`) | WER, cpWER, DER | Downloads AMI audio and the models |
| `node scripts/eval/cluster-lab.cjs` | The sessions, without Whisper | DER and speaker count for each voice model, window size and clustering bar | The models |
| `node scripts/eval/voice-scores.cjs` | The sessions' enroll.wav against each speaker | How a saved voice scores against its owner and everyone else | The models |
| `pnpm replay:session <id>` | A recorded session's kept audio | Who spoke each line; scores with `--reference` | The session's audio still kept |

`--pipeline live` (the default, what the app runs), `stream` (the lines as they land while
recording, labeled only by track, no relabel) or `offline` (diarize, then transcribe). Data and results go to `eval-data/`
(gitignored), or `LYRA_EVAL_DATA`; set `LYRA_MODELS_DIR` to download each model once.

Every run uses the same model files: they are pinned by revision and sha256
([THIRD_PARTY.md](../THIRD_PARTY.md)), so a change in a score comes from a change in Lyra.

## Results

Speaker and diarization changes report the `eval:sessions` and `eval:calls` tables before and
after in their pull request (AGENTS.md) and add their rows below with the date, the commit and
the number of sessions or scenarios. Sessions WER is driven by overlapping speech and the music and video sessions
(context-free read sentences under a loud backdrop); speaker errors are cpWER minus WER.

| Date | Commit | Suite | Pipeline | n | WER | cpWER | DER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-24 | b5e98d6 (before #48) | sessions v2, seed 1 | live | 16 (75 min) | 46.0% | 78.3% | 40.1% |
| 2026-11-24 | #48 | sessions v2, seed 1 | live | 16 (75 min) | 45.6% | 51.9% | 14.1% |
| 2026-11-24 | b5e98d6 (before #48) | calls | live | 11 | 10.9% | 44.6% | 25.1% |
| 2026-11-24 | #48 | calls | live | 11 | 10.2% | 24.7% | 11.3% |
| 2026-11-25 | a1b9824 (before audio audit) | sessions v2, seed 1 | live | 16 (75 min) | 22.8% | 28.8% | 13.9% |
| 2026-11-25 | audio audit (raw mic, Silero chunking, echo canceller) | sessions v2, seed 1 | live | 16 (75 min) | 21.4% | 26.9% | 12.6% |
| 2026-11-25 | a1b9824 (before audio audit) | calls | live | 11 | 2.3% | 19.4% | 13.5% |
| 2026-11-25 | audio audit (raw mic, Silero chunking, echo canceller) | calls | live | 11 | 2.5% | 19.8% | 12.5% |

## Not yet

- **No CI gate.** The suites need models and system voices, so they run on a developer machine.
  A model-free gate (the scorers against fixed hypothesis files) is the next step.

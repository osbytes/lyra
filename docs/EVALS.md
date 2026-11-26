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
| `pnpm eval:local` | Your own recordings, added with `node scripts/eval/local.cjs add <session>`: the audio is copied and the session's transcript as it stands (fix its speakers in the app first) becomes the reference. Kept in `eval-data/local/`, never in the repo | cpWER, DER, speaker count (WER says little: Whisper wrote the reference text) | The session's audio still kept |

`--pipeline live` (the default, what the app runs), `stream` (the lines as they stood when the
recording stopped: speakers settled every half minute, the newest lines not labeled yet, no
relabel) or `offline` (diarize, then transcribe). Data and results go to `eval-data/`
(gitignored), or `LYRA_EVAL_DATA`; set `LYRA_MODELS_DIR` to download each model once.

`relabeled` is the share of the speaker labels shown while recording that the pass after the stop
changed, by seconds of transcript (`src/main/meeting/labelChanges.ts`): what someone watching the
transcript saw corrected under them. cpWER and DER only score where the labels end up.

## The gate

`--check` compares a run with the stored baseline for its suite, pipeline and machine kind
(`scripts/eval/baselines/<suite>-<pipeline>-<platform>-<arch>.json`; `eval-data/local/baselines/`
for your own recordings) and exits 1 when a pooled rate (WER, cpWER, DER, relabeled) rose by more
than 2 points, an item's by more than 6, or an item of the baseline did not run
(`scripts/eval/baseline.cjs`). Rates move a point or two between runs with no change in Lyra,
hence the tolerances. `--update-baseline` stores a run as the baseline; commit it only with a
change that is meant to move the numbers, and say why in the pull request.

Run `LYRA_SESSIONS_CORPUS=mini pnpm eval:sessions --quick --check` on your own machine before a
pull request that touches the recording or speaker code. It is not a pull-request check:
GitHub's hosted macOS runners give Whisper a paravirtual GPU on which one four-minute session
takes about 35 minutes, so `.github/workflows/evals.yml` is started by hand, for a self-hosted
Apple-silicon runner. `pnpm eval:local --check` does the same for the recordings no generated
session stands in for.

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
| 2026-11-25 | before turn edges | sessions v2 mini, seed 1 | live | 17 (72 min) | 21.4% | 25.4% | 8.9% |
| 2026-11-25 | turn edges (`turnEdges.ts`) | sessions v2 mini, seed 1 | live | 17 (72 min) | 21.3% | 23.8% | 8.7% |
| 2026-11-25 | before turn edges | sessions v2 mini, seed 2 (not tuned on) | live | 5 (22 min) | 14.3% | 18.5% | 7.0% |
| 2026-11-25 | turn edges (`turnEdges.ts`) | sessions v2 mini, seed 2 (not tuned on) | live | 5 (22 min) | 14.3% | 16.5% | 6.3% |
| 2026-11-25 | before turn edges | calls (macOS voices) | live | 8 | 3.3% | 6.5% | 6.8% |
| 2026-11-25 | turn edges (`turnEdges.ts`) | calls (macOS voices) | live | 8 | 3.3% | 6.7% | 7.0% |

## Where the speaker errors are

Measured 2026-11-25 on the mini sessions, by scoring the transcribed words (an eval's
`<id>.hyp.json` keeps them with their times) against other speaker turns than the app's:

- **Mostly at the changes of speaker, not in who is who.** With the reference's own turns, the
  same words score within 2 to 5 points of WER; with the app's turns, 7 to 14 over it on rooms
  with quick turns. The clusters are right (speaker confusion of the raw diarization is about
  1% of speech time); the point where one turn ends and the next begins was only good to about
  a second. `turnEdges.ts` (a voiceprint search for the change, then a snap to the nearest
  pause or sentence end) closed about a third of that. The rest is the next thing to work on.
- **Tried and dropped: diarizing each track on its own.** Voiceprints from the track a window is
  loudest on, clustering each side apart, or segmenting each track: DER 7.5% → 8.4%, 8.7% and
  13.5% (music or a video on the system track becomes a speaker; the mix was already kept
  apart by the track rules).
- **Tried and dropped: running the segmentation model directly** (onnxruntime, 5 s hops, with
  overlapped speech kept). About 4.5 ms per second of audio against about 45 through
  sherpa-onnx, which runs it every second; but DER 7.5% → 8.7% with simple stitching of the
  windows, and it needs a second ONNX runtime shipped. Worth another look only for cost.

## Known limits of these numbers

An audit of the eval setup (2026-11-25) found these, and none of them is fixed yet. Read the
results above with them in mind:

- **Tuned on the test set.** The speaker thresholds (`src/main/meeting/thresholds.ts`, the
  clustering bars) were tuned with `cluster-lab.cjs` and `voice-scores.cjs` on the same sessions
  `eval:sessions` scores. There is no held-out set, so the sessions numbers are optimistic for
  voices and rooms they haven't seen.
- **`cluster-lab.cjs` is a copy.** It re-implements the clustering instead of importing the app's
  `clustering.ts`, so a sweep can disagree with what the app does after either one changes.
- **Speaker naming is not scored.** cpWER and DER only check that lines are grouped by the right
  person. Whether a saved voice puts the right *name* on them (or a wrong one) isn't measured.
- **No number or spelling normalisation.** The scorer (`scripts/eval/metrics.cjs`) lowercases and
  drops punctuation and fillers, but "twenty five" vs "25", "OK" vs "okay" or British vs American
  spellings count as errors, which inflates WER and cpWER against published results.
- **One seed, no variance.** Each row is a single draw (`seed 1`) of each session. Chunk
  boundaries alone move one session's WER by several points, and no row reports a spread, so a
  difference of a point or two between rows may be noise. `--seeds 3` exists but isn't used for
  the table.
- **The gate is a subset.** `evals.yml` checks five quick sessions on one machine kind; the full
  suites, the calls (system voices) and AMI still run by hand. The scorers have unit tests
  (`scripts/eval/metrics.test.mjs`, `baseline.test.mjs`, in `pnpm check`).

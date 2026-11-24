# Evals

How well Lyra transcribes and tells speakers apart, measured on audio with known answers. Public
claims about accuracy quote this file, with its date and sample size, or are not made.

## Suites

| Command (in `apps/lyra`) | Audio | Scores | Needs |
| --- | --- | --- | --- |
| `pnpm eval:calls` | Synthetic calls and rooms made with system text-to-speech: speaker bleed, clipping, quick turns, crosstalk, similar voices | WER, cpWER, DER, speaker count | Windows (SAPI voices) or macOS (`say`, no similar-voice cases); downloads the models |
| `pnpm eval:ami` | Real meetings from the AMI corpus (`--meetings`, `--minutes`, `--mic`) | WER, cpWER, DER | Downloads AMI audio and the models |
| `pnpm replay:session <id>` | A recorded session's kept audio | Who spoke each line; scores with `--reference` | The session's audio still kept |

`--pipeline live` (the default, what the app runs), `stream` (live identification alone, no
relabel) or `offline` (diarize, then transcribe). Data and results go to `eval-data/`
(gitignored), or `LYRA_EVAL_DATA`; set `LYRA_MODELS_DIR` to download each model once.

Every run uses the same model files: they are pinned by revision and sha256
([THIRD_PARTY.md](../THIRD_PARTY.md)), so a change in a score comes from a change in Lyra.

## Results

None recorded here yet. Speaker and diarization changes report the `eval:calls` table before and
after in their pull request (AGENTS.md); the next such run should also add its table below with
the date, the commit and the number of scenarios.

| Date | Commit | Suite | Pipeline | n | WER | cpWER | DER |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Not yet

- **No CI gate.** The suites need models and system voices, so they run on a developer machine.
  A model-free gate (the scorers against fixed hypothesis files) is the next step.

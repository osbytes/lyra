---
name: investigate-session
description: Debug a real Lyra session that came out wrong (missing or merged speakers, wrong names, lost or garbled words, bad notes), fix the cause, and add a de-identified eval case for it. Use when the user names a session (file, id, path or title) and says what went wrong and what they expected.
---

# Investigate a session

Input: a session (`2026-01-05_09-30-00.txt`, a path to it or its `.sessions/` folder, or a title)
plus what went wrong and what was expected ("3 people, got 1"). If either is missing, ask once.
Then go all the way: find the cause, fix it, add an eval case that fails before the fix and passes
after, and report. Use the [audio-pipeline role](../../roles/audio-pipeline.md).

**The session is the user's private data.** Real voices, words, names, meeting topics and titles
never leave this machine and never go into the repo, an eval, a commit, a PR, a log line or an
issue. See [De-identify](#de-identify) before writing anything that's committed.

## 1. Find it

- Notes live in the notes folder (`~/.lyra` unless `notesDir` in `userData/settings.json`
  says otherwise). A session is `<id>.txt` (or `.md`) + `<id>.lyra.json`, and
  `.sessions/<id>/` holds `session.json`, `doc.json`, `audio/mic.wav` + `audio/system.wav`
  (if kept: check `audioStatus` and `retainedUntil`) and `raw/` (`live.json`: every live chunk
  with its track and word times; `pass-N.json`: each relabel/diarized pass).
- A title: `grep -l` the `.lyra.json` files for it.
- The log is `userData/logs/lyra.log` (`%APPDATA%/lyra` on Windows,
  `~/Library/Application Support/lyra` on macOS): JSON lines. Take the lines between the
  session's `startedAt` and a minute after `endedAt`: `recorder stopped` (levels, coupling,
  echo canceller), `whisper transcribed`, `relabel diarized` (`liveSpeakers` → `speakers`),
  `meeting voice match`, `merged …`. The log has ids and numbers only, by design.

## 2. Reproduce

- `pnpm replay:session <id>` (in `apps/lyra`, `LYRA_MODELS_DIR` set to the app's
  `userData/models` to reuse downloads) re-runs the kept audio through each pipeline without
  changing the session. If it doesn't reproduce, the cause is in state the replay doesn't have
  (saved voices in `userData/voices.json`, settings, a take recorded in parts): say so and look there.
- No audio kept: work from `raw/` and the log alone, and say the fix can't be checked on the
  real audio.

## 3. Find the stage that went wrong

Walk the pipeline in order and stop at the first stage whose output is already wrong:

1. **Capture**: per-second levels of each track (`node scripts/eval/session-timeline.cjs <id>`
   prints them): a silent or very quiet track, speaker bleed, clipping.
2. **Live transcription**: `raw/live.json`: words per track, chunks missing or hallucinated.
3. **Diarization** (`src/main/meeting/worker.ts`, `clustering.ts`): segmentation pieces, window
   voiceprints, clustering at `DIARIZE_THRESHOLD`, folding of short speakers.
4. **Merging and naming** (`pipeline.ts`: `mergeTinySpeakers`, `mergeSamePerson`,
   `nameSpeakers`; `relabel.ts`: `assignWords`, `buildLines`).
5. **Notes** (`notes*.ts`), when the issue is the notes.

To look inside a stage, write throwaway scripts in your scratchpad (never the repo) that call
the real code: Node 22 runs the pure TypeScript modules with `--experimental-strip-types`
(copy e.g. `clustering.ts` to a `.mts` file and import it), and `sherpa-onnx-node` resolves with
`createRequire('<repo>/apps/lyra/package.json')`. Print numbers (similarities, labels, shares,
levels), not words. A cosine matrix of the segmentation pieces' voiceprints quickly shows whether
the voices really are separable (one person ≈ 0.6–0.9 with TitaNet, different people ≲ 0.35),
which tells a model or audio-quality problem from a clustering or merging one.

## 4. Fix it

- Fix the cause, not this session: a threshold nudged until this one passes will break another.
  Prefer evidence the pipeline already has but ignored (the track a word came from, word times,
  energy shares) over new constants.
- Every speaker fix trades one failure for its opposite: keeping a missed person can create
  phantom speakers (one person split in two), and merging phantoms can lose real people. Check
  the evals' `speakers found/actual` column for both directions, and when a scenario moves the
  wrong way, measure what tells the two apart (voiceprint similarity, track, words) on the eval
  sessions before choosing a bar.
- Follow `AGENTS.md` and `.agents/rules/typescript.md`. Comments say why, in general terms.
- Before editing, start the baseline evals (`pnpm eval:calls`, `pnpm eval:sessions`) on the
  unchanged code: they build once at the start, so wait for their first `running…` line before
  changing source, or the baseline measures your change.

## 5. Add the case as an eval

Rebuild the session's shape with corpus voices, so the eval reproduces the failure and nothing
of the real people is kept:

1. `node scripts/eval/session-timeline.cjs <id>` prints each stretch of speech (track, start,
   seconds, word count; no words) and a `script` skeleton with one person per track.
2. Split the people using what you found (the replay, voiceprint scores, what the user said:
   "two remote people"): give each turn its person. Round times to 0.1 s.
3. Add a `case-<shape>` entry to `SESSIONS` in `scripts/eval/sessions.cjs` with `people`
   (seats: `near` for the owner, `system` for remote people, `mid`/`far` for others in the
   room), `bleed` (laptop speakers) or `fan` when the levels showed them, and the `script`. Its
   comment says what failed in general terms ("one remote person does nearly all the talking and
   a second says one sentence late on"), never what was said or who said it.
4. If the failure is about something the session generator can't make (a specific sound, a
   pattern of chunk boundaries), add a scenario to `scripts/eval/calls.cjs` (TTS) instead, or a
   pure-function check with made-up data, and say why.
5. Run the case on the old code and the new: `pnpm eval:sessions --sessions case-<shape>`
   (sessions are cached under `eval-data/`; delete the case's folder after changing its entry).
   It must fail before the fix the same way the real session did, and pass after.
6. Keep the real session as a private case too, when the generated one can't stand in for it
   (it often can't: real rooms, microphones and Whisper's timing on real speech differ). Once
   the session's speakers are right in the app (the fix relabeled it, or the user corrected
   it), `node scripts/eval/local.cjs add <id> --name <shape>` copies its audio and transcript
   to `eval-data/local/` and `pnpm eval:local --check` replays it from then on. Name it by its
   shape ("desk-two-voices"), not by what or who it was. It stays on this machine: the folder
   is git-ignored, and neither the case nor its scores' text go in a commit or a report.

## De-identify

Before anything is committed, pushed or written outside the scratchpad:

- **Never copy** audio, voiceprints/embeddings, transcript text, words or phrases from it, names
  (people, companies, products, channels), the session title or tags, person ids from
  `voices.json`, or meeting topics. Not in code, comments, eval entries, commit messages, PR
  descriptions or reports meant for others. Times, durations, word counts, levels, similarity
  scores and speaker counts are fine.
- Name the case by its shape (`case-call-1+2-brief`), not by date, person or topic. The session
  id is a timestamp: keep it out of committed files.
- `eval-data/` is git-ignored; keep it that way, and keep replays (`eval-data/replays/`) there.
- Scan the diff before committing: `git diff` and grep it for a few distinctive words from
  the transcript and the names in the session; there must be no hits.
- In the report to the user you may quote their session (it's theirs, on their machine), but
  keep quotes short and never paste them into the PR.

## 6. Verify and report

- `verify-change` (`pnpm check`, `pnpm smoke:ui`), the `qa-test` skill, and `pnpm eval:sessions`
  + `pnpm eval:calls` before and after for any speaker or diarization change: report both tables
  and call out every scenario that moved.
- `pnpm replay:session <id>` again: the session now comes out as the user expected. Say if it
  only partly does, and why.
- Report: the cause (which stage, what evidence), the fix, the new case, the before/after
  numbers, and anything left. Offer to re-run the relabel on the real session if the user wants
  its transcript fixed; never change their session without asking.

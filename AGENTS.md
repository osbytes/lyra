# AGENTS.md

Lyra is a local-first desktop voice notebook: Electron + React + TypeScript, with on-device
Whisper transcription. Notes are plain `.txt`/`.md` files in a user-chosen folder (`~/.lyra`).
Roadmap: [docs/PLAN.md](docs/PLAN.md). Human contributor guide: [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` (pnpm only; never npm/yarn — the lockfile is `pnpm-lock.yaml`) |
| Run the app | `pnpm dev` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` (auto-fix: `pnpm lint:fix`) |
| Unit tests | `pnpm test` (in `apps/lyra`): vitest over `src/**/*.test.ts` and `scripts/**/*.test.mjs`; pure modules only, no Electron or models |
| Typecheck + lint | `pnpm check` (typecheck, lint, unit tests; also fails if `docs/CONFIG.md` is stale) — must pass before every commit |
| Config docs | `pnpm config:docs` (in `apps/lyra`) regenerates [docs/CONFIG.md](docs/CONFIG.md) from `src/main/envSpec.ts` and the task usage in `src/main/tasks/args.ts` |
| UI smoke test | `pnpm smoke:ui` (builds, launches Electron headless, exercises the IPC bridge) |
| Native addon smoke | `pnpm smoke` (only needed when touching `src/main/whisper.ts` or native deps) |
| QA with real audio | `node scripts/make-demo-audio.cjs` (in `apps/lyra`; Windows SAPI or macOS `say`) makes `test-audio/meeting.wav` (two synthetic voices); see the `qa-test` skill |
| Meeting pipeline smoke | `pnpm smoke:meeting <file.wav> [system.wav]`: replays the audio as a live recording (chunked Whisper per track, speakers labeled every half minute, relabel after stop); `--offline` runs diarize-then-transcribe instead; `--notes local` adds notes; `--no-relabel` keeps the labels given while recording; `--enroll owner.wav` saves a voice first; `LYRA_MODELS_DIR` reuses downloads |
| Speaker evals | `pnpm eval:sessions` (in `apps/lyra`): real voices (LibriSpeech, CC BY 4.0; needs ffmpeg) laid out as 2–6 person room, hybrid and call sessions with exact ground truth (Opus remote audio, speaker bleed, music or a video playing, a fan, backchannels, crosstalk); `--seeds 3` for three draws each, `--enroll` to save the owner's voice first; `pnpm eval:calls`: TTS call/room scenarios (speaker bleed, clipping, quick turns, crosstalk); `pnpm eval:ami` scores real AMI meetings (`--meetings`, `--minutes`, `--mic`); `pnpm eval:voxconverse` scores DER and speaker count on real VoxConverse debates and news clips, 2–8 people, that nothing was tuned on (`--files`, `--minutes`); `pnpm eval:zoom` (Windows; needs yt-dlp) scores DER on recorded Zoom meetings from YouTube, labelled from the video's active-speaker border and name tiles (`--videos`, `--minutes`). WER, cpWER, DER; data and results go to `eval-data/`. `--pipeline live` (default: what the app runs), `stream` (the lines as labeled while recording, before relabel), `offline`, or `capture` (mic-only items played as a fake microphone through the window's real capture path, in real time). Experiments: `--asr parakeet`, `--no-context` (Whisper without its prompt). `--quick` runs a fixed subset (about 2 min for calls, 4 for sessions) for direction while working; `--jobs 2` runs items in parallel. `--check` fails the run if it is worse than the stored baseline (`scripts/eval/baselines/`), `--update-baseline` stores it; `pnpm eval:local` scores your own recordings, added with `node scripts/eval/local.cjs add <session>` and kept out of the repo. Task runs are headless: no window opens |
| Tune speaker clustering | In `apps/lyra`, with `LYRA_MODELS_DIR`: `node scripts/eval/cluster-lab.cjs` sweeps voice models, window sizes and clustering bars on the sessions in seconds, without Whisper; `node scripts/eval/voice-scores.cjs` shows how a saved voice scores against its owner and everyone else (the basis for `meeting/thresholds.ts`) |
| Word lists | `pnpm word-lists` (in `apps/lyra`) regenerates `src/main/data/hallucinations.json` and `src/shared/data/whisperLanguages.json` from pinned upstream sources; never edit them by hand |
| Debug a mislabeled session | `pnpm replay:session <session id or folder>` (in `apps/lyra`): re-runs its kept audio through each pipeline and prints who spoke each line; `--reference ref.json` scores it. A session's `raw/live.json` has each chunk's words and the track it was heard on |
| Package (Windows dir build) | `pnpm build:unpack`; runs `prepare:llama`, which ships node-llama-cpp as its own npm install |
| Run the website | `pnpm dev:web` (http://localhost:3100); check with `pnpm --filter web check` and `pnpm --filter web build` |

## Layout

Turborepo + pnpm workspace. The app is `apps/lyra/`; every path below (and in `.agents/`) is relative to it
unless it says otherwise. Run `pnpm` scripts from the repo root (they go through `turbo`) or inside `apps/lyra`.
Repo-level files (`.changeset/`, `.github/`, `docs/`, `scripts/release-*`, `turbo.json`) stay at the root.

The website is `apps/website/` (Next.js, deployed to Vercel, never released or versioned): a landing page
with an animated hero, screenshots of the app from `pnpm screenshot`, and download links. The same
TypeScript rules apply. The site has no telemetry and makes no third-party requests at runtime (fonts are
self-hosted; GitHub is called from the server only).

- `src/main/` — Electron main process: files, settings, Whisper, tray/hotkeys/overlay, mic watcher, recorder, updater. Node APIs live here only.
- `src/main/meeting/` — speaker pipeline (diarization worker, voiceprints) and meeting notes (`NotesWriter`: the local worker, or any AI SDK provider). Workers run in `utilityProcess`.
- `src/preload/` — the `window.api` bridge. Thin: `ipcRenderer.invoke`/`on` wrappers, no logic.
- `src/renderer/src/` — React UI, audio capture (`audio/`), hooks, text helpers. Browser APIs only.
- `src/shared/types.ts` — types shared across processes, including the `VoicePagesApi` contract.
- `src/main/sessionStore.ts` + `src/shared/sessionDoc.ts` — sessions: each note is a plain
  document (`doc.json`; main owns it, windows send typed edits over IPC and are sent what
  changed), exported to the `.txt`/`.md` file plus a `.lyra.json` metadata file. Audio and raw
  model passes live in `.sessions/<id>/`. `components/Transcript.tsx` edits the transcript and
  speakers through the same edits (`hooks/usePages.ts`).
  Design: [docs/SESSION-MODEL.md](docs/SESSION-MODEL.md) (repo root).
- `src/main/searchIndex/` — the search index: a local libSQL database in `userData/index/`
  that mirrors sessions and people (derived data; deleting it loses nothing). It's owned by a
  `utilityProcess` (`worker.ts`); `service.ts` keeps it in step through the session store's
  change events. Use `@libsql/client` only: libsql's sync API aborts the process on a binary
  parameter. Design: [docs/SEARCH-INDEX.md](docs/SEARCH-INDEX.md) (repo root).
- `src/main/activity.ts` + `src/shared/activity.ts` — Activity: every long-running task's
  progress, ending and error, kept in main and shown in the sidebar (or the top bar when it's
  hidden). Rules for every loading, progress, success and error state: [docs/STATES.md](docs/STATES.md).
- `src/main/config.ts` + `src/main/envSpec.ts` — the environment, parsed once at startup. Standard
  names (the AI SDK providers' `*_API_KEY` / `*_BASE_URL`, `HF_ENDPOINT`) where one exists, `LYRA_` only for Lyra's own.
- `src/main/tasks/` — one-off tasks the app binary runs from its command line (`smoke`,
  `screenshot`, `meeting`); the `pnpm` scripts launch them.
- `scripts/` — build, release and smoke-test launchers (CommonJS).
- `scripts/llama/` — the pinned npm lockfile for the node-llama-cpp tree that `prepare-llama.cjs`
  installs with `npm ci` and ships beside the app (outside `pnpm-lock.yaml`).
- `.agents/` — roles, skills and rules for coding agents (see below).

## Rules

- **TypeScript:** follow [.agents/rules/typescript.md](.agents/rules/typescript.md). Never use `any`,
  `as any`, `@ts-ignore`, or non-null `!`. Use `unknown` and narrow. `pnpm lint` enforces this.
- **Process boundaries:** renderer never imports Node or Electron modules; it goes through
  `window.api`. Every new IPC channel is added in all four places (see the `add-ipc-channel` skill).
- **Validate at the boundary:** anything arriving over IPC, from disk, or from the network is
  `unknown` until checked. File paths from the renderer go through `resolveInNotes()`.
- **Local-first:** no telemetry. Network calls only for model downloads, updates, and features the
  user explicitly opts into (e.g. cloud meeting notes). Never send note content anywhere by default.
- **Logging:** use `log(scope, message, data)` (`src/main/log.ts`, `src/renderer/src/lib/log.ts`),
  not `console.*`. Log ids, counts and timings, never note text, transcripts or keys (the UI
  smoke test checks the log file).
- **Schemas:** a shape that crosses a boundary (IPC, disk, env, argv, a model's reply) is one zod
  schema; its type is `z.infer` of it. Don't write a type and a separate validator.
- **Models:** code that needs a model takes a `NotesWriter` (or another interface) as a
  dependency; only `src/main/meeting/writers.ts` constructs AI SDK providers.
- **Config:** read the environment through `config()`, never `process.env` (lint enforces it).
  A new variable goes in `envSpec.ts`; prefer an existing standard name over a `LYRA_` one.
- **Style:** match surrounding code. Prettier-style formatting: 2 spaces, single quotes, no
  semicolons, ~100-column lines. Comments explain *why*, not *what*.
- **Line endings:** LF everywhere, on every OS; `.gitattributes` enforces it and `.editorconfig`
  sets it for editors.
- **Scope:** one change per commit/PR. Don't reformat or refactor unrelated files.

## Boundaries — never do these

- Don't add dependencies without saying why; prefer the platform and existing utilities.
- Don't edit `pnpm-lock.yaml` by hand, `out/`, `dist/`, or generated files.
- Don't weaken `tsconfig*.json` strictness or disable lint rules to make an error go away. A
  targeted `eslint-disable-next-line` needs a comment on the line above saying why.
- Don't delete or move user notes in code paths without an explicit user action.
- Don't commit secrets, API keys, or real user notes/audio.

## Testing

- Run `pnpm check` and `pnpm smoke:ui` before saying a change is done.
- Pure logic (no Electron, no models, no app state) gets a vitest unit test next to the module
  (`foo.ts` → `foo.test.ts`; `scripts/**/*.test.mjs` for scripts). `pnpm test` runs them and
  `pnpm check` includes it. Compute expected values by hand; don't snapshot whatever the code returns.
- New behavior in `src/main/` that the renderer can reach gets a case in `runUiSmoke`
  (`src/main/tasks/smoke.ts`).
- Audio, transcription, diarization or meeting-notes changes: QA with real audio per the `qa-test` skill
  (`test-audio/meeting.wav`), comparing output to the known script. Smoke tests alone don't count.
  Speaker or diarization changes also run `pnpm eval:sessions` and `pnpm eval:calls` and report the
  tables before and after. `LYRA_SESSIONS_CORPUS=mini pnpm eval:sessions --quick --check` is the
  gate for them (docs/EVALS.md; too slow for hosted CI, so it is yours to run); run it, and `pnpm eval:local --check` when you have cases.
- UI changes: launch `pnpm dev` and look at the change; say so if you couldn't.

## Commits and PRs

- Imperative, sentence-case subject ending in a period (e.g. `Add settings and a configurable notes
  folder.`), then a short body of `- ` bullets when useful.
- PR description: what changed, why, and how it was verified.

## Roles and skills

Pick the role that matches the task and follow its file; load a skill when its trigger applies.

| Role | Use for |
| --- | --- |
| [main-process](.agents/roles/main-process.md) | Files, settings, IPC handlers, native modules, OS integration |
| [renderer](.agents/roles/renderer.md) | React components, hooks, styles, UX |
| [audio-pipeline](.agents/roles/audio-pipeline.md) | Capture, VAD, streaming transcription, speakers |
| [reviewer](.agents/roles/reviewer.md) | Reviewing a diff before commit or PR |

| Skill | Use when |
| --- | --- |
| [add-ipc-channel](.agents/skills/add-ipc-channel/SKILL.md) | Exposing a new main-process capability to the renderer |
| [add-setting](.agents/skills/add-setting/SKILL.md) | Adding a user-configurable setting |
| [qa-test](.agents/skills/qa-test/SKILL.md) | Changes touching audio, Whisper, speakers or meeting notes; any request to QA or test with audio |
| [investigate-session](.agents/skills/investigate-session/SKILL.md) | A real session came out wrong: find the cause, fix it, add a de-identified eval case (`/investigate-session` in Claude Code) |
| [verify-change](.agents/skills/verify-change/SKILL.md) | Before declaring any change done or committing |
| [app-media](.agents/skills/app-media/SKILL.md) | Taking, retaking or editing any screenshot or screen recording of the app or website |

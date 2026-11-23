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
| Typecheck + lint | `pnpm check` — must pass before every commit |
| UI smoke test | `pnpm smoke:ui` (builds, launches Electron headless, exercises the IPC bridge) |
| Native addon smoke | `pnpm smoke` (only needed when touching `src/main/whisper.ts` or native deps) |
| QA with real audio | `powershell -File scripts/make-demo-audio.ps1` makes `test-audio/meeting.wav` (two synthetic voices); see the `qa-test` skill |
| Meeting pipeline smoke | `pnpm smoke:meeting <file.wav> [system.wav]`: replays the audio as a live recording (streaming Whisper, live speakers, relabel after stop); `LYRA_MEETING_PIPELINE=offline` runs diarize-then-transcribe instead; `LYRA_NOTES_ENGINE=local` adds notes; `LYRA_MODELS_DIR` reuses downloads |
| Speaker evals | `pnpm eval:calls` (in `apps/lyra`): synthetic call/room scenarios with exact ground truth (speaker bleed, clipping, quick turns, crosstalk, similar voices); `pnpm eval:ami` scores real AMI meetings (`--meetings`, `--minutes`, `--mic`). WER, cpWER, DER; data and results go to `eval-data/`. `--pipeline live` (default: what the app runs), `stream` (live identification alone) or `offline` |
| Debug a mislabeled session | `pnpm replay:session <session id or folder>` (in `apps/lyra`): re-runs its kept audio through each pipeline and prints who spoke each line; `--reference ref.json` scores it. A session's `raw/live.json` `trace` has every live speaker decision |
| Package (Windows dir build) | `pnpm build:unpack`; runs `prepare:llama`, which ships node-llama-cpp as its own npm install |
| Run the website | `pnpm dev:web` (http://localhost:3100); check with `pnpm --filter web check` and `pnpm --filter web build` |

## Layout

Turborepo + pnpm workspace. The app is `apps/lyra/`; every path below (and in `.agents/`) is relative to it
unless it says otherwise. Run `pnpm` scripts from the repo root (they go through `turbo`) or inside `apps/lyra`.
Repo-level files (`.changeset/`, `.github/`, `docs/`, `scripts/release-*`, `turbo.json`) stay at the root.

The website is `apps/website/` (Next.js, deployed to Vercel, never released or versioned). Its live demo draws
with the app's real stylesheet, scoped under `.lyra-ui` by `apps/website/scripts/sync-app-styles.mjs` on every
dev and build, and ports a few pure helpers and components. The same TypeScript rules apply. The site has
no telemetry and makes no third-party requests at runtime (fonts are self-hosted; GitHub is called from
the server only).

- `src/main/` — Electron main process: files, settings, Whisper, tray/hotkeys/overlay, mic watcher, recorder, updater. Node APIs live here only.
- `src/main/meeting/` — speaker pipeline (diarization worker, voiceprints) and meeting notes (local worker, Claude). Workers run in `utilityProcess`.
- `src/preload/` — the `window.api` bridge. Thin: `ipcRenderer.invoke`/`on` wrappers, no logic.
- `src/renderer/src/` — React UI, audio capture (`audio/`), hooks, text helpers. Browser APIs only.
- `src/shared/types.ts` — types shared across processes, including the `VoicePagesApi` contract.
- `src/main/sessionStore.ts` + `src/shared/sessionDoc.ts` — sessions: each note is a Yjs document
  (main owns it, windows hold replicas over IPC), exported to the `.txt`/`.md` file plus a
  `.lyra.json` metadata file. Audio and raw model passes live in `.sessions/<id>/`.
  `components/Transcript.tsx` edits the transcript and speakers through the same document.
  Design: [docs/SESSION-MODEL.md](docs/SESSION-MODEL.md) (repo root).
- `scripts/` — build, release and smoke-test scripts (CommonJS).
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
  not `console.*`.
- **Style:** match surrounding code. Prettier-style formatting: 2 spaces, single quotes, no
  semicolons, ~100-column lines. Comments explain *why*, not *what*.
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
- New behavior in `src/main/` that the renderer can reach gets a case in `runUiSmoke`
  (`src/main/index.ts`).
- Audio, transcription, diarization or meeting-notes changes: QA with real audio per the `qa-test` skill
  (`test-audio/meeting.wav`), comparing output to the known script. Smoke tests alone don't count.
  Speaker or diarization changes also run `pnpm eval:calls` and report the table before and after.
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
| [verify-change](.agents/skills/verify-change/SKILL.md) | Before declaring any change done or committing |

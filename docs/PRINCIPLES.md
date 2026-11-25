# Principles

How Lyra is built, and why. The day-to-day rules for contributors and agents are in
[AGENTS.md](../AGENTS.md) and [.agents/rules/typescript.md](../.agents/rules/typescript.md); this
page records the decisions behind them, including where Lyra departs from the osbytes playbook.

## Local first

- Notes are plain `.txt`/`.md` files in a folder the user picks. Lyra never locks them into a
  format only it can read, and never deletes or moves them without an explicit user action.
- Audio, transcripts and voiceprints stay on the device. Lyra goes online for three things only:
  downloading its models, checking for updates, and cloud summaries when the user turns them on.
  No telemetry.
- Anything that records, uploads or uses the network is off by default.

## Interface

- **Work in progress is always in view.** While Lyra is still working on something the user is
  looking at (processing a session's audio, labeling speakers, writing a summary), the sign of it
  sits in fixed chrome such as a header bar, never in content that scrolls or collapses away.
  Results may still change until it finishes, so the user must be able to tell at a glance
  wherever they are on the page.

## Twelve factors, for a desktop app

[12factor.net](https://12factor.net/) is written for services; this is how each factor reads for
an Electron app.

| Factor | In Lyra |
| --- | --- |
| Codebase | One repo (app and website), one pnpm lockfile |
| Dependencies | Lockfile installs only (`--frozen-lockfile`); Node pinned in `.nvmrc` and `engines`; every model pinned by revision and sha256 ([THIRD_PARTY.md](../THIRD_PARTY.md)) |
| Config | User choices are Settings. Machine setup is the environment, read once by `src/main/config.ts` and listed in [CONFIG.md](CONFIG.md). Standard names (the AI SDK providers' `*_API_KEY` / `*_BASE_URL`, `HF_ENDPOINT`) where they exist; `LYRA_` only for Lyra's own. A bad value stops the app with its name. Lint forbids `process.env` elsewhere |
| Backing services | Model hosts, the summary model and the update feed are swapped by config, never by a code change: `HF_ENDPOINT`, the provider and model in Settings, `*_BASE_URL` |
| Build, release, run | CI builds installers from a tag; releases carry provenance attestations and an SBOM; nothing is compiled on the user's machine |
| Processes | Heavy work (diarization, local notes) runs in `utilityProcess` workers that hold no state; the session document lives in the main process and on disk |
| Port binding | Not applicable: Lyra serves nothing |
| Concurrency | One instance per user (single-instance lock); parallel work goes to workers |
| Disposability | Starts without network; on quit, finishes a running recording, flushes sessions, and gives up after 10 s rather than hang; downloads land in a temp file and are renamed |
| Dev/prod parity | The same binary runs the app and its test tasks; CI runs the UI smoke test on Windows, where Lyra is developed; models are byte-identical everywhere |
| Logs | One JSON object per line to a rotated file in the user-data folder (the "platform" for a desktop app), plus a readable terminal line in development. Content-free, checked by the smoke test |
| Admin processes | One-off tasks (`smoke`, `screenshot`, `meeting`) are subcommands of the app binary, not separate scripts with their own copy of the logic |

## Code

- **Validate at the boundary.** IPC payloads, files and network responses are `unknown` until
  checked. Config and command-line tasks are parsed once, at startup.
- **One zod schema per shape.** Settings, the environment, task arguments and model replies are
  each a zod schema; the TypeScript type is `z.infer` of it, and the same schema parses the input.
  No hand-written type plus a separate validator.
- **Model calls behind one interface.** Notes and titles depend on `NotesWriter`
  (`src/main/meeting/notesWriter.ts`), never on a provider SDK. The AI SDK adapter runs any
  provider; the local adapter runs the on-device model; a fake serves tests. `createServices()`
  (`src/main/services.ts`) wires them, and the provider SDKs are constructed only in
  `src/main/meeting/writers.ts`.
- **No casts.** Narrow instead; older casts are listed in `CAST_BASELINE` and that list only
  shrinks.
- **Unions over flags, exhaustive switches.** A new case is a compile error until handled.
- **Comments say why.**
- **One change per pull request**, with what was checked and what wasn't.

## Where Lyra departs from the playbook

| Playbook default | Lyra | Why |
| --- | --- | --- |
| AGPL-3.0 core | MIT, permanently | A settled decision, not a gap to close: Lyra stays MIT. Audits against the playbook should not flag it |
| One Docker image, `deploy/` folder | Signed installers per OS | Lyra is a desktop app |
| Biome | ESLint + typescript-eslint `strictTypeChecked` | Already in place and type-aware |
| vitest | The UI smoke test (`pnpm smoke:ui`) and the evals | Most behaviour needs Electron; a unit runner is worth adding when pure modules grow |
| `noPropertyAccessFromIndexSignature` | Off | About a hundred stylistic changes for little safety; revisit with the next large refactor |
| MCP tool and CLI per feature | Not yet | The app is the only surface today |

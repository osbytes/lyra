---
name: verify-change
description: Verify a Lyra change before calling it done, committing, or opening a PR. Runs the typecheck, lint, and smoke tests and checks the diff against the project rules.
---

# Verify a change

Run these from the repo root and fix every failure before continuing. Don't skip a step silently —
if one can't run, say which and why.

1. `pnpm check` — typecheck (both tsconfigs) + ESLint. Zero errors, zero warnings.
2. `pnpm smoke:ui` — must print `ui-smoke: ok`. Expected "Invalid page id" errors in the log come
   from the path-guard checks and are fine.
3. `pnpm smoke` — only if `src/main/whisper.ts`, native dependencies, or `electron-builder.yml`
   changed.
4. UI or audio change → run `pnpm dev` and exercise it (light and dark mode for UI; a short
   dictation for audio).
5. Read your own diff (`git diff`) with the [reviewer role](../../roles/reviewer.md) checklist:
   - no `any`, `!`, or unexplained `eslint-disable`
   - no unrelated changes or reformatting
   - line endings preserved (CRLF files stay CRLF)

Report what you ran and the result. "Done" means every applicable step above passed.

# Contributing to Lyra

Thanks for wanting to help. Lyra is a local-first voice notebook — keep PRs small and focused.

## Setup

**Requirements:** Node.js 20+ (22 recommended) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

On macOS, grant microphone access when prompted. The first **Record** click downloads the Whisper `base.en` model (~150 MB) into the app data folder.

The website lives in `apps/website` (Next.js). Run it with `pnpm dev:web` and open http://localhost:3100.

## Checks

Run these before opening a pull request:

```bash
pnpm check      # typecheck + lint + docs/CONFIG.md is current (see .agents/rules/typescript.md)
pnpm smoke      # native Whisper addon loads in Electron
pnpm smoke:ui   # page create/save/list/delete through the UI bridge
pnpm smoke:meeting <file.wav>   # real speaker pipeline on a 16 kHz mono WAV (downloads models)
```

## Pull requests

- One change per PR. Say why, not just what.
- Stay local-first: no telemetry, and nothing leaves the device by default. Cloud features must be explicit opt-ins with a clear warning (like Claude meeting notes).
- Match the existing code style. Don’t reformat unrelated files.

## Release

Every PR carries a changeset: run `pnpm changeset` and write the note for someone using Lyra (`pnpm changeset --empty` for docs-only or internal changes). CI refuses a PR without one.

Merging to `main` keeps a "Release vX.Y.Z" PR open with the next version and `CHANGELOG.md`. Merging that PR tags `vX.Y.Z`, and GitHub Actions builds the installers and publishes the GitHub Release. The full flow is in [docs/RELEASING.md](docs/RELEASING.md).

## Conduct

Be kind. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

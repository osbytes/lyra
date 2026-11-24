# Releasing

Lyra is one desktop app shipped as installers for macOS, Windows and Linux, versioned with
[changesets](https://github.com/changesets/changesets). The version lives in the root
`apps/lyra/package.json`; nothing is published to npm (`"private": true`).

## Every pull request

1. Make the change. Run `pnpm typecheck`, and `pnpm smoke` / `pnpm smoke:ui` when it touches
   native code, IPC or pages.
2. `pnpm changeset`: pick `lyra`, pick the bump, write the note **as a user reads it**
   ("Pages can be reordered in the sidebar", not "refactor page store"). One changeset per
   user-visible change; a PR can have several. Docs-only or internal PRs: `pnpm changeset --empty`.
3. If the change needs anything from the user at upgrade time (a moved notes folder, a setting
   that changed meaning, a model to re-download, a behaviour that changed), add an `**Upgrade:**`
   line to the changeset. It ends up in the changelog and the GitHub release.
4. CI (`ci.yml`) typechecks, lints and bundles the app, and refuses a PR without a changeset. It
   doesn't package installers; only `release.yml` does. `release.yml` also runs on a PR that
   touches packaging (`electron-builder.yml`, `apps/lyra/package.json`, the lockfile, the
   workflow itself) and builds every installer there without publishing.

## Versions (before 1.0)

- **patch**: fixes, small improvements, dependency updates, anything with no new setting.
- **minor**: new features, new settings, changed defaults, changes to how pages are stored on disk,
  anything a user would call "new".
- **major**: reserved for 1.0. Until then, breaking changes are minor and say so in `**Upgrade:**`.

Pages are plain markdown files on the user's disk, so a downgrade normally works: install the
older release over the newer one. A release that changes the on-disk layout or the settings file
in a way older versions cannot read says so in its `**Upgrade:**` line.

## Cutting a release

1. Merging to `main` runs `version.yml`, which keeps a **"Release vX.Y.Z"** pull request open. It bumps
   the version, writes `CHANGELOG.md` from the pending changesets and deletes them. Review it like
   any PR: is the changelog readable, are upgrade notes present.
2. The release PR bumps `apps/lyra/package.json`, so `release.yml` builds the release candidate
   on it: the `macOS`, `Windows` and `Linux` checks. Don't merge until all three pass; a release
   that can't build fails here, before its tag exists. Download the installers from that run (the
   `*-dist` artifacts), install at least one over the current release, and check that pages open,
   dictation records and transcribes, and Settings shows the new version.
3. Merge. `version.yml` runs `pnpm release:tag`, which pushes `vX.Y.Z`. `release.yml` builds the
   installers on macOS, Windows and Linux, attests them (`gh attestation verify <file> --owner
   osbytes`), and publishes the GitHub release with the `.dmg`, `.zip`, `-setup.exe`,
   `.AppImage`, `.deb`, blockmaps and `latest*.yml`. The release notes are the changelog section
   (`scripts/release-notes.mjs`; maintainers' "Thanks @…!" credits are dropped, outside
   contributors' stay).
4. On a machine running the previous release, use **Check for updates** and confirm it finds,
   downloads and installs the new version.

Installs learn about the release from GitHub's `releases/latest` through electron-updater
(`src/main/updater.ts`, which reads the `latest*.yml` files attached to the release). A
pre-release is never "latest" there (`allowPrerelease` is off), so a release that must not be
offered to users can stay a GitHub pre-release.

By hand, without the workflow: `pnpm release:version` on `main`, commit, `pnpm release:tag`.

## A release that failed

If `release.yml` fails on a tag, the tag exists but has no GitHub release, and `releases/latest`
keeps offering the previous version. Re-running that run doesn't help: it uses the workflow as it
was at the tag. Fix the cause on `main`, then publish the tag from there:

```bash
gh workflow run release --ref main -f tag=vX.Y.Z
```

That run builds the tag's own source with `main`'s workflow, attests it and publishes the release.
It is marked latest only if no newer version tag exists, and a tag that already has a release is
refused.

## Pre-releases

`pnpm changeset pre enter beta` on `main` (or a release branch); every release is then
`X.Y.Z-beta.N` and `release.yml` marks the GitHub release as a pre-release (tags containing `-`).
`pnpm changeset pre exit` before the final release.

## Hotfixes

Branch from the tag (`git switch -c hotfix/1.2.1 v1.2.0`), cherry-pick the fix with its
changeset, `pnpm release:version`, commit, `pnpm release:tag`. Merge the branch back into `main`
so the changelog and version stay ahead.

## Setup (once per repository)

Repository settings live outside the code, so this list is the record of them; change it with the
setting.

- `secrets.RELEASE_TOKEN`: a fine-grained PAT of `adavila0703` with `contents: write` and
  `pull-requests: write` on this repository. It is required because tags pushed with the default
  `GITHUB_TOKEN` do not trigger `release.yml`. changesets/action (the Release PR),
  `pnpm release:tag` and the Dependabot changeset job all use it, never `GITHUB_TOKEN`. The tag
  ruleset below lets only that user create `v*` tags, so the PAT must be theirs.
- Settings → Actions → General:
  - "Workflow permissions": **Read repository contents**, and "Allow GitHub Actions to create and
    approve pull requests" **off**. Every workflow declares its own `permissions:`, so the default
    only catches a workflow that forgets to. Nothing creates PRs with `GITHUB_TOKEN`.
  - "Require actions to be pinned to a full-length commit SHA": **on**. Every `uses:` is a SHA
    with a `# vX.Y.Z` comment.
- Settings → Branches → `main`: require the `changeset`, `macOS`, `Windows` and `Linux` checks
  (`ci`), with branches up to date before merging. The Release PR is merged like any other. The
  `main` ruleset also blocks force pushes and deletion.
- Settings → Rules → tag ruleset `v*`: restricts creation, update, deletion and force pushes, with
  only `adavila0703` on the bypass list. A `v*` tag push publishes installers that every install
  will offer as an update, so only the release flow may create one, and a published version can
  never be moved to another commit.
- Settings → Advanced Security: Dependabot security updates, secret scanning and push protection
  are on. Private vulnerability reporting is on (`SECURITY.md`).

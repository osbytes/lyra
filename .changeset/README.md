# Changesets

Every pull request that changes the app carries a changeset: a small markdown file here that names
the bump and says, for someone using Lyra, what changed.

```bash
pnpm changeset          # pick lyra, pick patch or minor, write the note
pnpm changeset --empty  # docs-only or internal change
```

CI refuses a PR without one. The "Release" pull request turns the pending changesets into
`apps/lyra/CHANGELOG.md` and the next version. See [docs/RELEASING.md](../docs/RELEASING.md).

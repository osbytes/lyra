# Lessons from past runs

Newest first. Each entry is something a run missed or learned the hard way.
Read before starting; promote an entry into `SKILL.md` once it is a rule,
then delete it here.

## 2026-11-25: replacing a website still

- Next's image optimizer in `pnpm dev:web` keeps serving the old picture when a file in `public/` is overwritten under the same name. Give the new still a new name (named for what it shows) and update the reference.
- On Windows, `pnpm screenshot` failed with `UnknownVizError` whenever another window covered the task window; `capture-screenshot.cjs` now passes the switches that fix it and capture at 2x.

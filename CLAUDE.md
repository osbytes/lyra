@AGENTS.md

## Claude Code

- `AGENTS.md` (imported above) is the source of truth for every agent. Put shared rules there, not
  here; this file holds only Claude-specific notes.
- Roles and skills live in `.agents/`, which Claude Code does not auto-load. When a task matches a
  role or skill listed in `AGENTS.md`, read that file before starting.
- The TypeScript rules in `.agents/rules/typescript.md` apply to every `.ts`/`.tsx` edit. Read it
  before your first TypeScript change in a session.
- This repo is developed on Windows and macOS. Every text file is LF on every OS;
  `.gitattributes` enforces it, so don't write CRLF even on Windows.
- Finish every change with the `verify-change` skill.

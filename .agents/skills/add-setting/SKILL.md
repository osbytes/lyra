---
name: add-setting
description: Add a user-configurable setting to Lyra (stored in settings.json, editable in the Settings dialog). Use when a feature needs a preference, toggle, path, or shortcut.
---

# Add a setting

Settings are one zod schema, `SettingsSchema` in `src/shared/settings.ts`. The `Settings` type is
`z.infer` of it (re-exported from `src/shared/types.ts`); there is no separate type or validator
to keep in step.

1. **Schema** — add the field to `SettingsSchema` in `src/shared/settings.ts` with a doc comment.
   Put every constraint in the schema (`z.enum`, `z.int().min().max()`, `.nullable()`, a refined
   string like `ServerUrl` or `AbsolutePath`), so a bad value is refused in one place.
2. **Default** — add it to `defaultSettings()` in `src/main/settings.ts`. Defaults must be safe:
   anything that records, uploads, or uses the network is off by default. Say why in a comment
   when the default isn't obvious.
3. **Reading old and hand-edited files** — nothing to write for a new field: `parseSettings`
   layers the stored file over the defaults and falls back to the previous value for any field
   the schema refuses, so a missing or malformed value never stops Lyra from starting.
   - Renamed a field or changed what its values mean? Map the old shape in `migrate()` in
     `src/shared/settings.ts`, never in callers.
   - A nested object field: `updateSettings` replaces top-level fields whole. Merge the nested
     object there (as it does for `micPrompt`) if the UI sends partial updates of it.
4. **React to changes in main** — if main needs to act when it changes (re-register a hotkey,
   restart a watcher), subscribe with `onSettingsChanged((next, prev) => …)` in
   `src/main/settings.ts` and compare the field.
5. **UI** — add a `<Row>` to the right section component in
   `src/renderer/src/components/Settings.tsx`, reading from `settings` and writing with
   `update({ field })`.
6. **Renderer use** — read it via `useSettings()` (`src/renderer/src/hooks/useSettings.ts`);
   don't cache it elsewhere.
7. **Test** — `parseSettings` is pure: add a case to `src/shared/settings.test.ts` (create it if
   it doesn't exist; `pnpm test` runs it) that a bad stored value falls back, and a smoke case in
   `src/main/tasks/smoke.ts` (`runUiSmoke`) when the renderer can set it through `window.api`.

Settings live in `userData/settings.json`, never in the notes folder. Secrets (API keys) are not
settings: they are stored with Electron `safeStorage` (`src/main/secrets.ts`).

Finish with the `verify-change` skill.

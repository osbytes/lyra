---
name: add-setting
description: Add a user-configurable setting to Lyra (stored in settings.json, editable in the Settings dialog). Use when a feature needs a preference, toggle, path, or shortcut.
---

# Add a setting

1. **Type** — add the field to `Settings` in `src/shared/types.ts` with a doc comment.
2. **Default** — add it to `defaultSettings()` in `src/main/settings.ts`. Defaults must be safe:
   anything that records, uploads, or uses the network is off by default.
3. **Validation** — in `src/main/settings.ts`:
   - Top-level scalar fields: add an entry to `FIELD_CHECKS` (a type guard such as `isString`,
     `isBool`, or `oneOf('a', 'b')`).
   - Nested objects or values that need clamping: handle them in `applyValidFields`.
   Unknown or malformed stored values must fall back to the previous value, never throw.
4. **React to changes in main** — if main needs to act when it changes (re-register a hotkey,
   restart a watcher), subscribe with `onSettingsChanged((next, prev) => …)` and compare fields.
5. **UI** — add a `<Row>` to the right `<Section>` in `src/renderer/src/components/Settings.tsx`,
   reading from `settings` and writing with `update({ field })`.
6. **Renderer use** — read it via `useSettings()`; don't cache it elsewhere.

Settings live in `userData/settings.json`, never in the notes folder. Secrets (API keys) are not
settings: store them with Electron `safeStorage`.

Finish with the `verify-change` skill.

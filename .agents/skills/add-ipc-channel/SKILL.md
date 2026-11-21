---
name: add-ipc-channel
description: Add a new IPC channel so the renderer can call main-process code (or receive events from it). Use whenever window.api needs a new method or subscription.
---

# Add an IPC channel

A channel touches four files. Add it to all four in one change.

1. **Contract** — `src/shared/types.ts`: add the method to `VoicePagesApi` with a doc comment.
   Request/response types go in the same file.
   - Call: `doThing: (input: Input) => Promise<Output>`
   - Event: `onThing: (callback: (value: Value) => void) => () => void` (returns unsubscribe)
2. **Handler** — `src/main/index.ts`, in `registerIpc()`:
   ```ts
   ipcMain.handle('area:doThing', (_event, input: unknown) => doThing(parseInput(input)))
   ```
   - Name channels `area:verb` (`pages:save`, `settings:update`).
   - The argument is `unknown`; validate it (or pass it to a function that does) before use.
   - Put the logic in a domain module (`pages.ts`, `settings.ts`, …), not inline.
   - Events: `win.webContents.send('area:changed', value)` to every window.
3. **Bridge** — `src/preload/index.ts`: add the method to `api`.
   - Call: `doThing: (input) => ipcRenderer.invoke('area:doThing', input)`
   - Event: `onThing: (callback) => subscribe<Value>('area:thing', callback)`
4. **Use** — call `window.api.doThing(...)` from a hook in `src/renderer/src/hooks/`, not directly
   from deep inside components.

Then add a case to `runUiSmoke` in `src/main/index.ts` that calls the new method through
`window.api`, and run the `verify-change` skill.

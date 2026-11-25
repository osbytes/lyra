# Threat model

One page, kept current with the code. Every threat has a control (and where it is checked), an
accepted risk, or an open item. Last reviewed 2026-11-25.

## What Lyra holds

| Asset | Where | Why it matters |
| --- | --- | --- |
| Notes and transcripts | The notes folder (`~/.lyra` by default) | Private speech, often about other people |
| Session audio | `.sessions/<id>/` under the notes folder, deleted after the retention setting | Recordings of other people's voices |
| Voiceprints | `<userData>` (`voices.ts`) | Biometric data: identifies a person across recordings |
| Cloud model API keys | `<userData>/keys/<provider>.bin`, encrypted with the OS keychain (`safeStorage`), or the provider's standard variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`). On Linux a key is only saved when a real keyring (GNOME Keyring, KWallet) backs `safeStorage`; Electron's `basic_text` fallback is as good as plain text, so Lyra refuses it and names the variable to use instead | Billed to the user's account |
| The app log | `<userData>/logs/lyra.log` | Read when debugging and attached to issue reports |

## Trust boundaries

1. **Renderer ↔ main.** The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node) and
   reaches the main process only through `window.api`. Main treats it as untrusted: every
   argument is checked, it never sends a file system path (only page ids), and the channels that
   change settings, keys or the notes folder answer only the main window (the overlay shares the
   preload).
2. **The network.** Model downloads (Hugging Face, GitHub releases), update checks (GitHub
   releases), and the cloud model the user picks for summaries (Anthropic, OpenAI, Google, or their own OpenAI-compatible server), only when they turn that on.
3. **The disk.** Notes, sidecars and session folders can be edited by other tools.

## Threats and controls

| Threat | Control | Checked by |
| --- | --- | --- |
| A tampered or swapped model file runs in the app | Every model is pinned to a revision and its sha256 is checked before use; a mismatch is deleted | `src/main/models.ts`; verified by hand against each upstream file (no automated mismatch test yet) |
| A renderer bug reads or writes files outside the notes folder | Every path from the renderer is a page id that goes through `resolveInNotes()`: a plain `.txt`/`.md` name directly in the folder, with no `:` (NTFS streams), control characters, Windows device names (`CON`, `NUL`, `COM1`…) or trailing dots and spaces. A `.sessions` that is a link or junction is refused before anything is written through it | `src/main/notePath.test.ts` (traversal, drive-relative, UNC, case, device names, symlinked `.sessions`); UI smoke path-guard cases |
| A compromised renderer points the notes root somewhere else (a network share, another user's files, a file) | Main owns the folder: `settings:pickFolder` shows the native picker and switches itself; `settings:update` refuses `notesDir` outside task runs; `notes:move` takes no path (main remembers the previous folder); `notes:reveal` and the tray open the folder only once it is known to be a directory. The switch is refused while recording, and open sessions are written first | `src/main/ipcSchemas.test.ts`; `src/main/notesFolder.ts` |
| Malformed data over IPC | Each channel's arguments are one zod schema (`src/main/ipcSchemas.ts`): ids are capped strings, session updates are non-empty `Uint8Array`s with a size cap, a settings patch takes only known fields | `src/main/ipcSchemas.test.ts`; lint (`no-unsafe-*`); UI smoke (bad session updates are refused) |
| Another window (the overlay) calls settings, key, folder or import/export channels | Those handlers check the sender is the main window's `webContents` | `isFromMainWindow` (`src/main/session.ts`) |
| A window navigates away, opens a new window, a local file or a custom protocol | Every `webContents` (via `web-contents-created`, so the overlay and any later window too) blocks `will-navigate`, denies new windows and `<webview>`; only `http(s)` links go to the OS browser | `src/main/index.ts` (`lockDownContents`) |
| A page or window other than Lyra's own gets the microphone | `media` is granted only to the main window on the app's own page (the bundled file, or the dev server in development), and never for video; system audio (`getDisplayMedia`) answers only the main window's top frame | `src/main/appOrigin.test.ts`; `registerPermissions` |
| Transcripts sent in the clear to a server the user named | `cloudBaseUrl` must be `https`, except on this computer (`localhost`, `127.0.0.0/8`, `::1`) | `src/main/ipcSchemas.test.ts` (`isLoopbackUrl`) |
| The release binary is driven from its command line or environment (`smoke`, `meeting --notes cloud`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) | Packaged builds refuse task names unless `LYRA_ALLOW_TASKS` is set. Electron fuses (`electron-builder.yml`) turn off run-as-node, `NODE_OPTIONS`, the inspector flags, loading the app from outside `app.asar`, and turn on asar integrity checking | `src/main/tasks/run.ts`; packaged build |
| Note content or keys end up in logs and issue reports | Logs carry ids and counts only. Crashes, unhandled errors and dead helper processes are logged by reason and message only, never a stack or the data being handled | UI smoke: the log file is checked for the text it wrote and for the test key |
| Notes sent to a cloud service without the user choosing it | Summaries are off by default; a cloud model is used only when picked in Settings, with a notice naming where the transcript goes | `defaultSettings()`; `chooseWriter` (UI smoke: off chooses no writer); a key alone never sends anything |
| A model's reply drives the app (wrong shape, injected fields) | Replies are parsed with the same zod schema the model was asked to fill; anything else is an error | UI smoke: a malformed mock reply is refused |
| A bad environment variable silently changes behaviour | Parsed once at startup; a malformed value stops the app, naming it | UI smoke: `checkConfigParsing` |
| A malicious update | electron-updater checks each download against the sha512 in the release's `latest*.yml`; installers carry build-provenance attestations and the release an SBOM. See the accepted risk below: the builds are not code-signed | `release.yml` |
| Recording people without their knowledge | A one-time consent notice before the first meeting recording | `meetingNoticeSeen` |

## Accepted risks

- **Anyone with the user's OS account can read the notes folder.** Notes are plain files by
  design so other tools can open them; disk encryption is the OS's job.
- **Voiceprints are not encrypted at rest.** Same reason as above; they never leave the device.
- **Updates are only as trustworthy as the GitHub release.** The sha512 comes from the same
  release as the installer, so it catches a corrupted or swapped download, not a compromised
  release or publishing account. The builds aren't code-signed: on Windows electron-updater has
  no publisher to verify the installer against, and on macOS Lyra doesn't install in place (it
  opens the releases page) unless the running app has a Developer ID signature. Build-provenance
  attestations let a user check an installer by hand.
- **The renderer is served from `file://` with Electron's extra file privileges** (the
  `grantFileProtocolExtraPrivileges` fuse stays on): its module scripts need them. Moving to a
  custom protocol would let that fuse go too.
- **A plain-`http` server on the local network is refused** for summaries; it needs `https` or a
  tunnel to `localhost`.

## Open items

- No dependency licence allowlist in CI yet.
- No automated test that a model with the wrong hash is refused.
- Changing the notes folder doesn't yet wait for speaker relabeling to finish (only for a
  recording), and doesn't release open session documents before the switch, only writes them.
- The Electron fuses are only exercised by a packaged build; no CI job launches one yet.

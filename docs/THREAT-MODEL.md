# Threat model

One page, kept current with the code. Every threat has a control (and where it is checked), an
accepted risk, or an open item. Last reviewed 2026-11-23.

## What Lyra holds

| Asset | Where | Why it matters |
| --- | --- | --- |
| Notes and transcripts | The notes folder (`~/.lyra` by default) | Private speech, often about other people |
| Session audio | `.sessions/<id>/` under the notes folder, deleted after the retention setting | Recordings of other people's voices |
| Voiceprints | `<userData>` (`voices.ts`) | Biometric data: identifies a person across recordings |
| Cloud model API keys | `<userData>/keys/<provider>.bin`, encrypted with the OS keychain (`safeStorage`), or the provider's standard variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) | Billed to the user's account |

## Trust boundaries

1. **Renderer ↔ main.** The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node) and
   reaches the main process only through `window.api`.
2. **The network.** Model downloads (Hugging Face, GitHub releases), update checks (GitHub
   releases), and the cloud model the user picks for summaries (Anthropic, OpenAI, Google, or their own OpenAI-compatible server), only when they turn that on.
3. **The disk.** Notes, sidecars and session folders can be edited by other tools.

## Threats and controls

| Threat | Control | Checked by |
| --- | --- | --- |
| A tampered or swapped model file runs in the app | Every model is pinned to a revision and its sha256 is checked before use; a mismatch is deleted | `src/main/models.ts`; verified by hand against each upstream file (no automated mismatch test yet) |
| A renderer bug reads or writes files outside the notes folder | Every path from the renderer goes through `resolveInNotes()` | UI smoke: path-guard cases (`../`, hidden files, other extensions) |
| Malformed data over IPC | Handlers take `unknown` and validate | Lint (`no-unsafe-*`), UI smoke (bad session updates are refused) |
| The renderer navigates away or opens a local file or custom protocol | `will-navigate` is blocked; only `http(s)` links go to the OS browser | `src/main/index.ts` |
| Note content or keys end up in logs and issue reports | Logs carry ids and counts only | UI smoke: the log file is checked for the text it wrote and for the test key |
| Notes sent to a cloud service without the user choosing it | Summaries are off by default; a cloud model is used only when picked in Settings, with a notice naming where the transcript goes | `defaultSettings()`; `chooseWriter` (UI smoke: off chooses no writer); a key alone never sends anything |
| A model's reply drives the app (wrong shape, injected fields) | Replies are parsed with the same zod schema the model was asked to fill; anything else is an error | UI smoke: a malformed mock reply is refused |
| A bad environment variable silently changes behaviour | Parsed once at startup; a malformed value stops the app, naming it | UI smoke: `checkConfigParsing` |
| A malicious update | electron-updater checks each download against the sha512 in the release's `latest*.yml`; installers carry build-provenance attestations and the release an SBOM | `release.yml` |
| Recording people without their knowledge | A one-time consent notice before the first meeting recording | `meetingNoticeSeen` |

## Accepted risks

- **Anyone with the user's OS account can read the notes folder.** Notes are plain files by
  design so other tools can open them; disk encryption is the OS's job.
- **Voiceprints are not encrypted at rest.** Same reason as above; they never leave the device.

## Open items

- No dependency licence allowlist in CI yet.
- No automated test that a model with the wrong hash is refused.

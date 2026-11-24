# Troubleshooting

## Logs

Lyra writes one JSON object per line to `lyra.log` in its user-data folder, and keeps the previous
file as `lyra.old.log` once it passes 5 MB:

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\Lyra\logs` |
| macOS | `~/Library/Application Support/Lyra/logs` |
| Linux | `~/.config/Lyra/logs` |

A development build (`pnpm dev`) uses a `lyra` folder in the same place.

Each line has `time`, `scope`, `message` and sometimes `data`: ids, counts and timings, never the
text of a note, a transcript or an API key. The first line after a start lists which
configuration variables are set (names only).

## "Lyra can't start" with a variable named

An environment variable Lyra reads is set to something it can't use: a relative path, or a URL
that isn't `http`/`https`. The message names it. Fix or unset it; the variables are listed in
[CONFIG.md](CONFIG.md).

## A model download fails

- **"does not match its pinned hash"**: the file that arrived is not the one Lyra was built and
  tested with (a proxy or mirror served something else, or the download was cut short). Lyra
  deletes it and tries again next time. If you use `HF_ENDPOINT`, check the mirror serves the same
  revision.
- **"Download failed (4xx/5xx)"**: the host refused or is down. Behind a firewall, set
  `HF_ENDPOINT` to a mirror you can reach, or copy the files into `LYRA_MODELS_DIR` by hand: the
  names, sources and hashes are in [THIRD_PARTY.md](../THIRD_PARTY.md).

## The session shortcut does nothing

Another app holds the same global shortcut. Settings shows a badge on General when registration
failed; pick a different shortcut there.

## Cloud summaries don't run

Settings → Sessions shows a badge when cloud summaries are missing something: an API key, a model
(OpenAI and Google have no default), or the server address for an OpenAI-compatible server. A
key saved there wins over the provider's environment variable. Errors from the provider (a bad
key, no credit, a model id it doesn't know) are shown on the session and logged under `notes`.

## Quitting takes a few seconds

On quit Lyra finishes a recording that is still running, writes pending exports and compacts
session logs. It waits at most 10 seconds, then quits anyway and logs `quit flush timed out`.

---
'lyra': patch
---

Model downloads (Whisper, speaker models and the local notes model) are pinned to one upstream revision and checked against a sha256 hash, so a changed or corrupt file is never loaded. A copy downloaded by an earlier version is checked once and kept if it matches.

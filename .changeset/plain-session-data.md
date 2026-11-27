---
'lyra': patch
---

Sessions are now kept as plain JSON (`doc.json` in the session folder) instead of a Yjs document. Existing sessions move over the first time they're opened, with their notes, summary, transcript, speakers and tags intact; the old file is kept beside it as `doc.yjs.migrated`.

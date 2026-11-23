---
"lyra": minor
---

Each note is now a session that merges edits from every source (your typing, meeting labeling, generated notes) instead of the last save winning, and Ctrl+Z undoes only your own edits. A `.lyra.json` file beside each note describes it for scripts and agents.

**Upgrade:** on first launch Lyra creates a hidden `.sessions` folder in your notes folder and a `.lyra.json` beside each note; your note files are not changed. From now on Lyra writes the note file from the session: edits made to it in another editor are kept as a backup copy in `.sessions/<note>/external/` but not read back yet.

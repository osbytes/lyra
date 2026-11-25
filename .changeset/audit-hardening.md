---
'lyra': minor
---

Sturdier recordings and sessions. A crash, a failed or interrupted model download, or opening your notes with an older or newer version of Lyra no longer loses a recording or damages a session. Saved voices no longer learn from Lyra's own guesses, so one wrong match can't make the next one more likely, and a speaker you assign by hand stays assigned. Summaries can now come from a server on your own computer (Ollama, LM Studio) as its own choice in Settings, with a test button; a summary you edited is never rewritten without asking. Settings gains an About tab (versions, storage, copyable diagnostics), permission status, a custom vocabulary for names and jargon, and a confirmation before lowering "Keep audio" deletes recordings. The transcript can be used from the keyboard. Intel Macs now get their own download.

Things to know when updating: saved voices move to a new file format that older versions of Lyra can't read; a summaries server address that uses plain `http://` to another computer is cleared (use `https://`, or a server on this computer); and the search index is rebuilt once, so meaning-based search takes a little while to catch up.

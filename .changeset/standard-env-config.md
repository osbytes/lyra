---
'lyra': minor
---

Lyra reads the standard `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` variables (a key or model chosen in Settings still wins) and `HF_ENDPOINT` for a Hugging Face mirror, alongside `LYRA_NOTES_DIR` and `LYRA_MODELS_DIR`. A malformed value stops Lyra with a message naming the variable. Settings → Sessions gains a Claude model field. All variables are listed in docs/CONFIG.md.

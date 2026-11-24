---
'lyra': minor
---

Cloud summaries work with any provider: Anthropic, OpenAI, Google, or your own OpenAI-compatible server (Ollama, LM Studio, llama.cpp), picked with a model in Settings → Sessions. "With Claude" becomes "Cloud model", and an existing Claude setup and key carry over. Keys can also come from the providers' standard variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, plus `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`); a key saved in Settings wins. `HF_ENDPOINT` points model downloads at a Hugging Face mirror, alongside `LYRA_NOTES_DIR` and `LYRA_MODELS_DIR`. A malformed value stops Lyra with a message naming the variable. All variables are listed in docs/CONFIG.md.

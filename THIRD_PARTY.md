# Third-party components

What Lyra downloads or ships that someone else made, with its licence. Checked 2026-11-23 against
each model card and package manifest. Update this file in the same change that adds, bumps or
removes one of these.

## Models

Downloaded on first use into `<userData>/models` (or `LYRA_MODELS_DIR`), each pinned to one
upstream revision and checked against its sha256 before it is loaded (`src/main/models.ts`).

| Model | Used for | Licence | Source (pinned) |
| --- | --- | --- | --- |
| Whisper `large-v3-turbo`, 5-bit ggml build (`ggml-large-v3-turbo-q5_0.bin`) | Transcription | MIT (whisper.cpp model card); the original OpenAI weights are released under MIT | [ggerganov/whisper.cpp @ 5359861](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1) |
| pyannote segmentation 3.0, ONNX export | Finding who speaks when | MIT ([pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)) | [csukuangfj/sherpa-onnx-pyannote-segmentation-3-0 @ 9403a69](https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/tree/9403a6902bb58e3d5ae8c7e77c3422de279db2e0) |
| NVIDIA NeMo TitaNet-small | Voiceprints | CC BY 4.0 ([model card](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small)); attribution: NVIDIA | [k2-fsa/sherpa-onnx release `speaker-recongition-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models), pinned by sha256 |
| Qwen2.5-3B-Instruct, Q4_K_M GGUF | Local meeting notes and titles (opt-in) | **Qwen Research License: non-commercial use only**; commercial use needs a licence from Alibaba Cloud | [Qwen/Qwen2.5-3B-Instruct-GGUF @ 7dabda4](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/tree/7dabda4d13d513e3e842b20f0d435c732f172cbe) |

"Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) Alibaba Cloud. All
Rights Reserved." Lyra is a non-commercial project, which the licence allows. Lyra's own code is
MIT, but the model's terms bind whoever runs it: anyone using Lyra commercially must leave local
summaries off or get a licence from Alibaba Cloud.

## Runtime libraries

The main ones; the full list is `pnpm-lock.yaml`, and each release attaches an SPDX SBOM.

| Package | Licence |
| --- | --- |
| Electron | MIT |
| `@kutalia/whisper-node-addon` (whisper.cpp) | MIT |
| `sherpa-onnx-node` | Apache-2.0 |
| `node-llama-cpp` (llama.cpp) | MIT |
| `ai` (AI SDK) and `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` (only when cloud summaries are on) | Apache-2.0 |
| `zod` | MIT |
| `yjs` | MIT |
| `fuse.js` | Apache-2.0 |
| `electron-updater` | MIT |
| `@electron-toolkit/utils` | MIT |

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
| Silero VAD v5.1.2, ggml build (`ggml-silero-v5.1.2.bin`) | Dropping non-speech inside each chunk, in whisper.cpp | MIT ([snakers4/silero-vad](https://github.com/snakers4/silero-vad)) | [ggml-org/whisper-vad @ 9ffd54a](https://huggingface.co/ggml-org/whisper-vad/tree/9ffd54a1e1ee413ddf265af9913beaf518d1639b) |
| Silero VAD v5, ONNX (`silero_vad_v5.onnx`) | Where a recording's chunks start and end | MIT ([snakers4/silero-vad](https://github.com/snakers4/silero-vad)) | [k2-fsa/sherpa-onnx release `asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models), pinned by sha256 |
| NVIDIA Parakeet TDT 0.6B v3, int8 ONNX | Evals only (`--asr parakeet`); not downloaded by the app | CC BY 4.0 ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)); attribution: NVIDIA | [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 @ ed5d745](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tree/ed5d745623472f97cfc2e6c2916ee248798fc5a8) |
| Qwen2.5-3B-Instruct, Q4_K_M GGUF | Local meeting notes and titles (opt-in) | **Qwen Research License: non-commercial use only**; commercial use needs a licence from Alibaba Cloud | [Qwen/Qwen2.5-3B-Instruct-GGUF @ 7dabda4](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/tree/7dabda4d13d513e3e842b20f0d435c732f172cbe) |

"Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) Alibaba Cloud. All
Rights Reserved." Lyra is a non-commercial project, which the licence allows. Lyra's own code is
MIT, but the model's terms bind whoever runs it: anyone using Lyra commercially must leave local
summaries off or get a licence from Alibaba Cloud.

## Word lists

Built into the app by `pnpm word-lists` (`apps/lyra/scripts/update-word-lists.cjs`), each source
pinned to a revision and a sha256. Only phrases seen often enough in each list are kept (the
counts are in the generated file).

| List | Used for | Licence | Source (pinned) |
| --- | --- | --- | --- |
| Bag of Hallucinations (Barański et al., ICASSP 2025) | What Whisper writes on noise, dropped when it is a whole chunk | MIT | [DSP-AGH/ICASSP2025_Whisper_Hallucination @ c6d6db1](https://github.com/DSP-AGH/ICASSP2025_Whisper_Hallucination/tree/c6d6db174d070e1fa4589f1a29bbec69e9ed0de9) |
| whisper-hallucinations (Sacha Arbonel) | The same, in many languages | MIT | [sachaarbonel/whisper-hallucinations @ 05c3a97](https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations/tree/05c3a97e8906426979fb7c4f64004af44104810c) |
| Whisper's language list (`whisper/tokenizer.py`) | The Language setting | MIT | [openai/whisper @ 8609812](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/whisper/tokenizer.py) |

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

import type { OfflineRecognizer } from 'sherpa-onnx-node'
import { z } from 'zod'
import type { TranscriptWord } from '../shared/types'
import { log } from './log'
import { ensureModelFile, type ModelFile } from './models'

/**
 * NVIDIA Parakeet TDT 0.6B v3 (int8, through sherpa-onnx), an alternative to Whisper for evals:
 * `pnpm eval:sessions --asr parakeet`. A transducer, so it can't loop or invent "Thanks for
 * watching" the way Whisper's decoder does, and its durations give each token a frame-accurate
 * time. 25 European languages, detected on its own. Not used by the app until the evals say it
 * should be (docs/EVALS.md).
 */
const REVISION =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8'

const file = (name: string, bytes: number, sha256: string): ModelFile => ({
  name: `parakeet-tdt-0.6b-v3-${name}`,
  url: `${REVISION}/${name}`,
  bytes,
  sha256
})

const ENCODER = file('encoder.int8.onnx', 652_282_294, '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479')
const DECODER = file('decoder.int8.onnx', 11_845_274, '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5')
const JOINER = file('joiner.int8.onnx', 6_355_277, 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98')
const TOKENS = file('tokens.txt', 93_939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d')

const THREADS = 4

const Result = z.object({
  tokens: z.array(z.string()),
  timestamps: z.array(z.number()),
  durations: z.array(z.number()).optional()
})

let recognizer: Promise<OfflineRecognizer> | null = null

async function load(): Promise<OfflineRecognizer> {
  const [encoder, decoder, joiner, tokens] = await Promise.all(
    [ENCODER, DECODER, JOINER, TOKENS].map((model) => ensureModelFile(model))
  )
  if (!encoder || !decoder || !joiner || !tokens) throw new Error('Parakeet model files missing')
  const { OfflineRecognizer } = (await import('sherpa-onnx-node')).default
  return OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: THREADS,
      provider: 'cpu',
      modelType: 'nemo_transducer'
    },
    decodingMethod: 'greedy_search'
  })
}

/** Tokens to words: a token starting with a space begins one; the rest attach to the last. */
function wordsOf(result: z.infer<typeof Result>): TranscriptWord[] {
  const words: TranscriptWord[] = []
  result.tokens.forEach((token, i) => {
    const start = result.timestamps[i] ?? 0
    const end = start + (result.durations?.[i] ?? 0.08)
    const last = words.at(-1)
    if (last && !/^\s/.test(token)) {
      last.text += token
      last.end = end
    } else if (token.trim()) {
      words.push({ text: ` ${token.trim()}`, start, end })
    }
  })
  return words
}

/** Same contract as `transcribePcm`; the prompt is ignored (a transducer takes none). */
export async function transcribeWithParakeet(pcm: Float32Array, _prompt = ''): Promise<TranscriptWord[]> {
  if (pcm.length < 4800) return []
  recognizer ??= load().catch((error: unknown) => {
    recognizer = null
    throw error
  })
  const model = await recognizer
  const started = Date.now()
  const stream = model.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: pcm })
  await model.decodeAsync(stream)
  const words = wordsOf(Result.parse(model.getResult(stream)))
  log('parakeet', 'transcribed', {
    audioSec: +(pcm.length / 16000).toFixed(2),
    runMs: Date.now() - started,
    words: words.length
  })
  return words
}

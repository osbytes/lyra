import type { Vad as SherpaVad } from 'sherpa-onnx-node'
import type { SpeechClassifier } from '../shared/audio/vad'
import { log } from './log'
import { ensureModelFile, type ModelFile } from './models'

/**
 * Silero VAD v5 as ONNX, for deciding where a recording's chunks start and end (`PauseChunker`).
 * An energy threshold took music, a fan or a video for speech and never found the pause, so a
 * chunk ran to the 28 s limit and was cut mid-word. Silero is what WhisperX and faster-whisper
 * cut by. A GitHub release asset, pinned by its hash. About 0.14 ms per 32 ms frame, so it runs
 * in main beside the chunker rather than in a worker.
 */
const SILERO: ModelFile = {
  name: 'silero_vad_v5.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx',
  bytes: 2_313_101,
  sha256: '6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396'
}

/** The worklet's frame size; Silero v5 works in 512-sample windows at 16 kHz. */
const WINDOW = 512
/**
 * Silero's own hysteresis is kept short: the voice detector decides when a pause ends a thought
 * (END_PAUSE), so Silero only has to say, frame by frame, whether someone is talking.
 */
const THRESHOLD = 0.5
const MIN_SILENCE_SECONDS = 0.1
const MIN_SPEECH_SECONDS = 0.064

let Vad: typeof SherpaVad | null = null
let modelPath: string | null = null

/** Downloads the model if needed. Recording works without it, on the energy detector. */
export async function ensureSpeechVad(): Promise<boolean> {
  try {
    modelPath = await ensureModelFile(SILERO)
    // Loaded on first recording, not at startup: it brings ONNX Runtime into main.
    Vad ??= (await import('sherpa-onnx-node')).default.Vad
    return true
  } catch (error) {
    log('speech-vad', 'unavailable, using the energy detector', String(error))
    modelPath = null
    return false
  }
}

/** A fresh Silero classifier for one track, or null when the model isn't loaded. */
export function createSpeechClassifier(): SpeechClassifier | null {
  if (!Vad || !modelPath) return null
  const vad = new Vad(
    {
      sileroVad: {
        model: modelPath,
        threshold: THRESHOLD,
        minSilenceDuration: MIN_SILENCE_SECONDS,
        minSpeechDuration: MIN_SPEECH_SECONDS,
        windowSize: WINDOW,
        maxSpeechDuration: 30
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: false
    },
    5
  )
  return {
    isSpeech: (frame) => {
      vad.acceptWaveform(frame)
      // Lyra keeps the audio itself; drop the detector's own copies of finished segments.
      while (!vad.isEmpty()) vad.pop()
      return vad.isDetected()
    }
  }
}

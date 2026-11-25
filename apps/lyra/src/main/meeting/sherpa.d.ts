// Minimal typings for the parts of sherpa-onnx-node Lyra uses (the package ships JSDoc only).
declare module 'sherpa-onnx-node' {
  export type SpeakerDiarizationSegment = { start: number; end: number; speaker: number }

  export type OfflineSpeakerDiarizationConfig = {
    segmentation: { pyannote: { model: string }; numThreads?: number; debug?: boolean }
    embedding: { model: string; numThreads?: number; debug?: boolean }
    clustering: { numClusters: number; threshold: number }
    minDurationOn?: number
    minDurationOff?: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig)
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerDiarizationSegment[]
  }

  export class OnlineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean })
    readonly dim: number
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }

  export type VadConfig = {
    sileroVad: {
      model: string
      threshold?: number
      minSilenceDuration?: number
      minSpeechDuration?: number
      windowSize?: number
      maxSpeechDuration?: number
    }
    sampleRate?: number
    numThreads?: number
    provider?: string
    debug?: boolean
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isDetected(): boolean
    isEmpty(): boolean
    pop(): void
    reset(): void
  }

  export type OfflineRecognizerConfig = {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string }
      tokens: string
      numThreads?: number
      provider?: string
      modelType?: string
      debug?: boolean
    }
    decodingMethod?: string
  }

  export class OfflineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<void>
    /** Parsed JSON; checked where it's used. */
    getResult(stream: OfflineStream): unknown
  }

  /**
   * `module.exports`, as a dynamic `import()` sees it: main loads the addon lazily, and Node's
   * ESM loader can't see the named exports of this CommonJS module, only the default.
   */
  const sherpa: { Vad: typeof Vad; OfflineRecognizer: typeof OfflineRecognizer }
  export default sherpa
}

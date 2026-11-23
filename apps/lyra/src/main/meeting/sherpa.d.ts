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
}

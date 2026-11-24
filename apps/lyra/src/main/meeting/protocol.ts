/** Messages between the main process and the speaker worker (a utilityProcess). */

export type SpeakerModels = { segmentation: string; embedding: string }

export type DiarizeRequest = {
  type: 'diarize'
  micPath: string
  systemPath: string | null
  models: SpeakerModels
  /** Voiceprint similarity under which two windows are different people; higher splits more. */
  threshold: number
}

export type EmbedRequest = {
  type: 'embed'
  samples: Float32Array
  models: SpeakerModels
}

export type WorkerRequest = (DiarizeRequest | EmbedRequest) & { id: number }

export type DiarizedSegment = {
  start: number
  end: number
  speaker: number
  /** Share of the segment's energy on the mic track (1 = all mic, 0 = all system audio). */
  micShare: number
}

export type ClusterEmbedding = { speaker: number; embedding: number[] }

export type DiarizeResult = {
  seconds: number
  segments: DiarizedSegment[]
  clusters: ClusterEmbedding[]
}

export type WorkerResponse =
  | { id: number; ok: true; result: DiarizeResult | number[] }
  | { id: number; ok: false; error: string }

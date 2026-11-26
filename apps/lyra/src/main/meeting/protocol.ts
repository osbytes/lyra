/** Messages between the main process and the speaker worker (a utilityProcess). */

export type SpeakerModels = {
  segmentation: string
  embedding: string
  /**
   * The speaker-activity model, when the user turned it on: a finished recording's turns then
   * come from it (`speakerActivity.ts`) and voiceprints only name the speakers it found.
   */
  activity: string | null
}

export type DiarizeRequest = {
  type: 'diarize'
  micPath: string
  systemPath: string | null
  models: SpeakerModels
  /** Voiceprint similarity under which two windows are different people; higher splits more. */
  threshold: number
  /** When transcribed words were heard, if they're known: a short speaker with words is kept. */
  words: { start: number; end: number }[] | null
}

/**
 * Diarizes a recording that is still being made. The worker keeps what it has worked out of the
 * recording `key` names, so each request only costs the audio since the last one.
 */
export type RollRequest = Omit<DiarizeRequest, 'type'> & { type: 'roll'; key: string }

export type EmbedRequest = {
  type: 'embed'
  samples: Float32Array
  models: SpeakerModels
}

export type WorkerRequest = (DiarizeRequest | RollRequest | EmbedRequest) & { id: number }

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

/** A rolling round's result, with what it cost: numbers for the log. */
export type RollResult = DiarizeResult & {
  stats: {
    /** Where this round's audio started, in seconds: everything before was kept from earlier. */
    from: number
    windows: number
    /** Windows whose voiceprint was taken this round; the rest were kept. */
    embedded: number
    ms: number
  }
}

export type WorkerResponse =
  | { id: number; ok: true; result: DiarizeResult | RollResult | number[] }
  | { id: number; ok: false; error: string }

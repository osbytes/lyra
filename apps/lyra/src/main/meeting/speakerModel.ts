/**
 * The speaker-embedding model voiceprints come from. Kept apart from `speakers.ts` (which needs
 * Electron) so the voice store's pure rules and their tests can use it.
 *
 * A voiceprint is only comparable with another from the same model: saved samples and session
 * voiceprints record this id, and scoring skips any that don't carry it.
 */
export const SPEAKER_EMBEDDING = {
  /** The model file's name, which changes whenever the model does. */
  model: 'nemo_en_titanet_small.onnx',
  /** TitaNet-small's embedding size. */
  dims: 192
} as const

/**
 * The model behind a voiceprint saved before voiceprints recorded one. The only earlier model,
 * WeSpeaker ResNet34, made 256-dimension vectors, so one of the current length is taken to be
 * the current model's; anything else can't be compared and is marked unknown.
 */
export function guessModel(vector: readonly number[]): string {
  return vector.length === SPEAKER_EMBEDDING.dims ? SPEAKER_EMBEDDING.model : 'unknown'
}

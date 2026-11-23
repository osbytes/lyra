/** Voice-matching thresholds shared by live speaker identification and the offline pipeline. */

/** A speaker whose audio is mostly on the mic track is the person at this computer. */
export const SELF_MIC_SHARE = 0.67

/**
 * Cosine similarity needed to name a speaker from a saved voice. Different people
 * score ~0.45 with this model; the same person across calls lands ~0.55–0.95,
 * lower when the voiceprint is one short clip, so the bar sits just above strangers.
 */
export const MATCH_THRESHOLD = 0.5

/** A match this strong is added to the person's voiceprint automatically. */
export const REINFORCE_THRESHOLD = 0.75

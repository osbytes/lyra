/** Voice-matching thresholds shared by relabeling after a recording and the offline pipeline. */

/** A speaker whose audio is mostly on the mic track is the person at this computer. */
export const SELF_MIC_SHARE = 0.67

/**
 * Cosine similarity needed to name a speaker from a saved voice. With TitaNet, half a minute of
 * someone's speech scores 0.73–0.91 against their saved voice and under 0.35 against anyone else,
 * in rooms, on calls and with music playing (scripts/eval/voice-scores.cjs); the bar sits between,
 * leaving room for a saved voice recorded on another mic or day.
 */
export const MATCH_THRESHOLD = 0.55

/** A match this strong is added to the person's voiceprint automatically (see LEARN_*). */
export const REINFORCE_THRESHOLD = 0.75

/**
 * Lyra learns a voice on its own only from a speaker with at least this much speech: a short
 * speaker's voiceprint is noisy, and a wrong sample makes every later match worse.
 */
export const LEARN_MIN_SECONDS = 20

/**
 * …and only when no other speaker in the session comes within this of the same saved voice. Two
 * speakers both close to one person means the session can't tell which one it is.
 */
export const LEARN_MARGIN = 0.15

/**
 * Average voiceprint similarity under which windows of speech are different people
 * (clustering.ts). Swept on three draws of each real-voice session (scripts/eval/cluster-lab.cjs,
 * the app's segmentation, 3 s windows): with short speakers folded (worker.ts), 0.3 had the
 * lowest DER (9%) and found the right number of people in 42 of 48. Two distinct voices can
 * average 0.26 (the QA script's David and Zira), so lower bars merge people; merging speakers
 * whose mean voiceprints were alike afterwards gained nothing.
 */
export const DIARIZE_THRESHOLD = 0.3

/**
 * A speaker who matches a saved voice this well is that person even when another speaker in the
 * session already matched them: the clustering split one person, so the two are merged.
 */
export const SAME_PERSON_THRESHOLD = 0.65

/**
 * …unless the two speakers' own voiceprints are this far apart. Different people score under
 * 0.35 against each other (see MATCH_THRESHOLD), and one person split in two doesn't; a saved
 * person both of them match that well holds samples of two voices (a speaker was named as the
 * wrong person once), and must not fold every later session's two speakers into one.
 */
export const SAME_PERSON_MIN_SIMILARITY = 0.35

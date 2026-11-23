import type { Line, Speaker, SpeakerState } from './types'

/** From apps/lyra/src/shared/sessionDoc.ts: below this a line's voice is "unsure". */
export const LOW_CONFIDENCE = 0.6
/** From apps/lyra/src/shared/sessionDoc.ts: at or above this a match needs no confirmation. */
export const SURE_MATCH = 0.85

export function stateOf(speaker: Speaker | undefined): SpeakerState {
  if (!speaker) return 'unknown'
  if (speaker.confirmed || (speaker.confidence ?? 0) >= SURE_MATCH) return 'sure'
  return speaker.personId ? 'likely' : 'unknown'
}

export function tier(confidence: number | null): 1 | 2 | 3 {
  if (confidence === null || confidence >= SURE_MATCH) return 3
  return confidence >= LOW_CONFIDENCE ? 2 : 1
}

export const percent = (value: number): string => `${String(Math.round(value * 100))}%`

export type ShownSpeaker = { name: string; state: SpeakerState; avatar: string }

/**
 * How a speaker shows at `t` seconds into playback. Before the saved-voice match lands, a voice
 * is still just "Speaker 2". Pass Infinity outside playback.
 */
export function shownSpeaker(speaker: Speaker | undefined, t: number): ShownSpeaker {
  if (!speaker) return { name: 'Speaker', state: 'unknown', avatar: '?' }
  if (speaker.matchAt !== null && t < speaker.matchAt && !speaker.confirmed) {
    return { name: speaker.anon, state: 'unknown', avatar: '?' }
  }
  const state = stateOf(speaker)
  return { name: speaker.name, state, avatar: state === 'unknown' ? '?' : speaker.name.charAt(0).toUpperCase() }
}

/** Speakers that have at least one line, in the order they're listed. */
export function presentSpeakers(speakers: Speaker[], lines: Line[]): Speaker[] {
  return speakers.filter((speaker) => lines.some((line) => line.cluster === speaker.id))
}

export const speakerName = (speakers: Speaker[], cluster: string): string =>
  speakers.find((speaker) => speaker.id === cluster)?.name ?? 'Speaker'

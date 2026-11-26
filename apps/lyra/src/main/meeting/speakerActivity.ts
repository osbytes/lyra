/**
 * Who spoke when, read straight from the audio by one model (NVIDIA Nemotron 3 Diarization)
 * instead of cutting speech into pieces, taking a voiceprint of each and clustering them. The
 * model gives, for each 10 ms, how likely each of up to eight people is speaking, so two people
 * talking at once are both heard. On real far-field meetings it found the right number of people
 * where the clustering path found up to twice as many (docs/EVALS.md).
 *
 * This file is the part without the model runtime: feeding a recording through in chunks, and
 * turning the probabilities into turns. `activityModel.ts` runs the network.
 */
import { MEL_BANDS, MEL_HOP, MEL_SAMPLE_RATE, logMel, type MelFeatures } from './melFeatures'
import { WHOLE_RECORDING, speakerCache } from './speakerCache'

/** The model reads eight 10 ms frames as one. */
const STACK = 8
/** Frames (of 80 ms) the model decides in one step, and how far past them it may look. */
const CHUNK_FRAMES = 340
const LOOK_AHEAD_FRAMES = 40
export const ACTIVITY_SPEAKERS = WHOLE_RECORDING.speakers
/** Size of the model's frame vectors. */
export const ACTIVITY_HIDDEN = 512
const FRAME_SECONDS = MEL_HOP / MEL_SAMPLE_RATE

export type ActivityStep = {
  /** Log-mel rows for the chunk and its look-ahead. */
  features: Float32Array
  featureFrames: number
  /** The cache and queue frames the chunk is read with. */
  cached: readonly Float32Array[]
}

export type ActivityStepResult = {
  /** Per 10 ms, for the cached frames then the chunk: a logit per speaker. */
  logits: Float32Array
  /** The chunk's own frame vectors (not the cached ones), `ACTIVITY_HIDDEN` values each. */
  frames: Float32Array
  /** The model's frame for silence. */
  silence: Float32Array
}

export type RunStep = (step: ActivityStep) => Promise<ActivityStepResult>

export type Activity = {
  /** `frames` rows of `ACTIVITY_SPEAKERS` probabilities, one row per 10 ms. */
  probabilities: Float32Array
  frames: number
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

/**
 * Reads a recording as it grows. The model works through audio in fixed steps from the start,
 * each read with what the speaker cache kept of the steps before, so a step's answer never
 * changes once given: what is read while recording is what the pass after the stop reads too,
 * and a voice keeps its channel from one round to the next.
 */
export type ActivityReader = {
  /** 10 ms frames whose answer is final. */
  settledFrames: () => number
  /**
   * Takes the features from `settledFrames()` on. Every whole step in them is settled; what is
   * left over (under half a minute) is read too, but provisionally: it is read again, with more
   * audio after it, next time. `last` settles everything: the recording has ended.
   */
  advance: (features: MelFeatures, run: RunStep, last: boolean) => Promise<Activity>
}

export function activityReader(): ActivityReader {
  const cache = speakerCache()
  let settled = new Float32Array(0)
  const settledFrames = (): number => settled.length / ACTIVITY_SPEAKERS

  /** One step over model frames [start, end) of `mel`, looking ahead to `ahead`. */
  async function step(
    mel: MelFeatures,
    run: RunStep,
    span: { start: number; end: number; ahead: number },
    keep: boolean
  ): Promise<Float32Array> {
    const cached = cache.frames()
    const from = span.start * STACK
    const to = Math.min(span.ahead * STACK, mel.frames)
    const result = await run({
      features: mel.data.subarray(from * MEL_BANDS, to * MEL_BANDS),
      featureFrames: to - from,
      cached
    })
    if (keep) {
      const seen = [
        ...cached,
        ...Array.from({ length: span.ahead - span.start }, (_, i) =>
          result.frames.slice(i * ACTIVITY_HIDDEN, (i + 1) * ACTIVITY_HIDDEN)
        )
      ]
      // The cache scores frames at the model's own rate: the mean over each stack of eight.
      const perFrame = seen.map((_, index) => {
        const row = new Float32Array(ACTIVITY_SPEAKERS)
        for (let k = 0; k < STACK; k++) {
          for (let speaker = 0; speaker < ACTIVITY_SPEAKERS; speaker++) {
            const logit = result.logits[(index * STACK + k) * ACTIVITY_SPEAKERS + speaker]
            row[speaker] = (row[speaker] ?? 0) + (logit === undefined ? 0 : sigmoid(logit) / STACK)
          }
        }
        return row
      })
      cache.update(seen, perFrame, result.silence, span.end - span.start)
    }
    const frames = Math.min(span.end * STACK, mel.frames) - from
    const probabilities = new Float32Array(frames * ACTIVITY_SPEAKERS)
    const offset = cached.length * STACK
    for (let i = 0; i < probabilities.length; i++) {
      const logit = result.logits[offset * ACTIVITY_SPEAKERS + i]
      if (logit !== undefined) probabilities[i] = sigmoid(logit)
    }
    return probabilities
  }

  return {
    settledFrames,
    async advance(mel, run, last) {
      // Until the recording ends, the frame that reaches past the audio isn't one yet.
      const usable = last ? mel.frames : Math.floor((mel.frames - 1) / STACK) * STACK
      const stacked = Math.ceil(usable / STACK)
      const view = { data: mel.data, frames: usable }
      let start = 0
      const parts: Float32Array[] = [settled]
      while (last ? start < stacked : start + CHUNK_FRAMES + LOOK_AHEAD_FRAMES <= stacked) {
        const end = Math.min(start + CHUNK_FRAMES, stacked)
        parts.push(await step(view, run, { start, end, ahead: Math.min(end + LOOK_AHEAD_FRAMES, stacked) }, true))
        start = end
      }
      const next = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
      let at = 0
      for (const part of parts) {
        next.set(part, at)
        at += part.length
      }
      settled = next
      if (start >= stacked) return { probabilities: settled, frames: settledFrames() }
      // What is left over: read with the cache as it stands, and not kept.
      const tail = await step(view, run, { start, end: stacked, ahead: stacked }, false)
      const all = new Float32Array(settled.length + tail.length)
      all.set(settled)
      all.set(tail, settled.length)
      return { probabilities: all, frames: all.length / ACTIVITY_SPEAKERS }
    }
  }
}

/** Reads a whole, finished recording. */
export function readActivity(audio: Float32Array, run: RunStep): Promise<Activity> {
  return activityReader().advance(logMel(audio), run, true)
}

export type Turn = { start: number; end: number; speaker: number }

export type TurnOptions = {
  /** Probability over which someone is taken to be speaking. */
  threshold: number
  /** A silence shorter than this inside one person's speech is a breath, not the end of a turn. */
  maxPauseSeconds: number
  /** Speech shorter than this, alone, is a cough or a click. */
  minTurnSeconds: number
}

export const TURN_DEFAULTS: TurnOptions = { threshold: 0.5, maxPauseSeconds: 0.5, minTurnSeconds: 0.2 }

/**
 * Each speaker's turns, in order of start. Turns of different speakers may overlap: that is two
 * people talking at once.
 */
export function activityTurns(activity: Activity, options: TurnOptions = TURN_DEFAULTS): Turn[] {
  const turns: Turn[] = []
  for (let speaker = 0; speaker < ACTIVITY_SPEAKERS; speaker++) {
    const own: Turn[] = []
    let start = -1
    for (let frame = 0; frame <= activity.frames; frame++) {
      const speaking =
        frame < activity.frames &&
        (activity.probabilities[frame * ACTIVITY_SPEAKERS + speaker] ?? 0) > options.threshold
      if (speaking && start < 0) start = frame
      if (speaking || start < 0) continue
      const turn = { start: start * FRAME_SECONDS, end: frame * FRAME_SECONDS, speaker }
      start = -1
      const last = own.at(-1)
      if (last && turn.start - last.end <= options.maxPauseSeconds) last.end = turn.end
      else own.push(turn)
    }
    turns.push(...own.filter((turn) => turn.end - turn.start >= options.minTurnSeconds))
  }
  return turns.sort((a, b) => a.start - b.start || a.speaker - b.speaker)
}

type Span = { start: number; end: number }

/**
 * Drops speakers who said next to nothing: the model sometimes gives a cough, a laugh or a
 * stretch of crosstalk a channel of its own. One with `minWords` transcribed words to themselves
 * stays, as a person who said one sentence is still a person. Their words then go to whoever
 * else was speaking.
 */
export function withoutFaintSpeakers(
  turns: readonly Turn[],
  minSeconds: number,
  words: readonly Span[] | null,
  minWords: number
): Turn[] {
  const speakers = [...new Set(turns.map((turn) => turn.speaker))]
  const kept = speakers.filter((speaker) => {
    const own = turns.filter((turn) => turn.speaker === speaker)
    if (own.reduce((sum, turn) => sum + turn.end - turn.start, 0) >= minSeconds) return true
    if (!words) return false
    const others = turns.filter((turn) => turn.speaker !== speaker)
    const inside = (word: Span, list: readonly Turn[]): boolean => {
      const middle = (word.start + word.end) / 2
      return list.some((turn) => turn.start <= middle && middle <= turn.end)
    }
    return words.filter((word) => inside(word, own) && !inside(word, others)).length >= minWords
  })
  return turns.filter((turn) => kept.includes(turn.speaker))
}

/**
 * Two channels that are active together for this share of the quieter one's speech are one
 * voice. People talk over each other for a few seconds of a meeting, never for most of what one
 * of them says.
 */
export const ECHO_SHARE = 0.7

const shared = (a: Span, b: Span): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * Joins channels that are one voice heard twice. A strong, distinct echo (the synthetic rooms of
 * the session evals have one; a bare meeting room might) makes the model report the echo as a
 * second person speaking along with the first. Real meetings measured so far have none, and are
 * left as they are.
 */
export function withoutEchoes(turns: readonly Turn[], share = ECHO_SHARE): Turn[] {
  let current = turns.map((turn) => ({ ...turn }))
  for (;;) {
    const speakers = [...new Set(current.map((turn) => turn.speaker))]
    const seconds = new Map(
      speakers.map((speaker) => [
        speaker,
        current.filter((turn) => turn.speaker === speaker).reduce((sum, turn) => sum + turn.end - turn.start, 0)
      ])
    )
    let closest: { keep: number; drop: number; share: number } | null = null
    for (const keep of speakers) {
      for (const drop of speakers) {
        if (keep >= drop) continue
        let together = 0
        for (const a of current) {
          if (a.speaker !== keep) continue
          for (const b of current) if (b.speaker === drop) together += shared(a, b)
        }
        const least = Math.min(seconds.get(keep) ?? 0, seconds.get(drop) ?? 0)
        const overlap = least > 0 ? together / least : 0
        if (overlap >= share && (!closest || overlap > closest.share)) closest = { keep, drop, share: overlap }
      }
    }
    if (!closest) break
    const { keep, drop } = closest
    // The two channels' turns become one speaker's, joined where they run into each other.
    const joined: Turn[] = []
    const own = current
      .filter((turn) => turn.speaker === keep || turn.speaker === drop)
      .sort((a, b) => a.start - b.start)
    for (const turn of own) {
      const last = joined.at(-1)
      if (last && turn.start <= last.end) last.end = Math.max(last.end, turn.end)
      else joined.push({ ...turn, speaker: keep })
    }
    current = [...current.filter((turn) => turn.speaker !== keep && turn.speaker !== drop), ...joined]
  }
  return current.sort((a, b) => a.start - b.start || a.speaker - b.speaker)
}

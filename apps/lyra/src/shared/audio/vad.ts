/**
 * Voice activity detection: speech (plus a short pre-roll so first syllables aren't clipped) is
 * forwarded, silence is not, and a long pause ends the thought. Sentence boundaries are left to
 * Whisper, which is far better at them than any pause heuristic.
 *
 * Which frames are speech comes from a `SpeechClassifier` when one is given (Silero, in main:
 * `src/main/speechVad.ts`), since a model tells a voice from music, a fan or a keyboard and an
 * energy threshold can't. Without one (tests, or the model failed to load) an energy detector with
 * an adaptive noise floor decides.
 */

export const SAMPLE_RATE = 16000

const MS = SAMPLE_RATE / 1000
const PRE_ROLL = 300 * MS
const ONSET = 90 * MS
/** A pause this long ends the thought: whatever is pending gets finalized. */
const END_PAUSE = 1200 * MS

const MIN_SPEECH_RMS = 0.004
const MIN_HOLD_RMS = 0.0025
const ONSET_RATIO = 3
const HOLD_RATIO = 1.8
/**
 * Ceilings on the thresholds, so a noisy room (or the floor estimate drifting
 * up) can never make ordinary speech undetectable.
 */
const MAX_SPEECH_RMS = 0.02
const MAX_HOLD_RMS = 0.012
/**
 * The noise floor is the quietest frame in this window ("minimum statistics").
 * Speech always has gaps between syllables within a few seconds, so talking
 * never drags the floor up to the level of the voice.
 */
const FLOOR_WINDOW = Math.round((3 * SAMPLE_RATE) / 512)

/** Says whether a frame is speech. Stateful: it must see every frame, in order. */
export type SpeechClassifier = {
  isSpeech: (frame: Float32Array) => boolean
}

export type VoiceEvents = {
  /**
   * Speech started; `frames` is the pre-roll, already including the onset, which is its last
   * `onset` samples (all of them heard as speech).
   */
  onStart: (frames: Float32Array[], onset: number) => void
  /**
   * A frame of audio during speech, including short pauses and the end pause itself: `voiced`
   * says whether this frame was heard as speech or is part of a pause.
   */
  onFrame: (frame: Float32Array, voiced: boolean) => void
  /** A long pause, or capture stopped. */
  onEnd: () => void
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

export type VoiceStats = {
  speaking: boolean
  noiseFloor: number
  onsetThreshold: number
}

export class VoiceDetector {
  private noiseFloor = 0.002
  private recent: number[] = []
  private speaking = false
  private onset = 0
  private silence = 0
  private preRoll: Float32Array[] = []
  private preRollLength = 0

  constructor(
    private readonly events: VoiceEvents,
    private readonly classifier: SpeechClassifier | null = null
  ) {}

  /**
   * Feeds one frame of 16 kHz audio and returns the RMS level it was judged by. `analysis` is the
   * same audio levelled for judging; `frame` is what's kept and handed on.
   */
  push(frame: Float32Array, analysis: Float32Array = frame): number {
    const energy = rms(analysis)
    this.trackFloor(energy)
    const speech = this.classifier?.isSpeech(analysis) ?? null
    // Silero keeps hearing speech through reverberation and breaths, which held chunks open far
    // past the pause; once speaking, a frame also has to be above the hold level to count.
    const held = energy >= this.holdThreshold()
    if (this.speaking) this.whileSpeaking(frame, speech === null ? held : speech && held)
    else this.whileWaiting(frame, speech ?? energy >= this.onsetThreshold())
    return energy
  }

  stats(): VoiceStats {
    return {
      speaking: this.speaking,
      noiseFloor: this.noiseFloor,
      onsetThreshold: this.onsetThreshold()
    }
  }

  private onsetThreshold(): number {
    return Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, this.noiseFloor * ONSET_RATIO))
  }

  private holdThreshold(): number {
    return Math.min(MAX_HOLD_RMS, Math.max(MIN_HOLD_RMS, this.noiseFloor * HOLD_RATIO))
  }

  private trackFloor(energy: number): void {
    this.recent.push(energy)
    if (this.recent.length > FLOOR_WINDOW) this.recent.shift()
    const quietest = Math.min(...this.recent)
    // Fall quickly, rise slowly.
    const rate = quietest < this.noiseFloor ? 0.3 : 0.02
    this.noiseFloor += (quietest - this.noiseFloor) * rate
  }

  /** Samples held in the pre-roll: heard, but not handed on (yet) in any event. */
  preRolled(): number {
    return this.preRollLength
  }

  flush(): void {
    if (this.speaking) {
      this.speaking = false
      this.events.onEnd()
    }
    this.preRoll = []
    this.preRollLength = 0
    this.onset = 0
  }

  private whileWaiting(frame: Float32Array, voiced: boolean): void {
    this.preRoll.push(frame)
    this.preRollLength += frame.length
    let oldest = this.preRoll[0]
    while (oldest && this.preRollLength - oldest.length >= PRE_ROLL) {
      this.preRoll.shift()
      this.preRollLength -= oldest.length
      oldest = this.preRoll[0]
    }

    if (voiced) {
      this.onset += frame.length
      if (this.onset >= ONSET) {
        const onset = this.onset
        this.speaking = true
        this.silence = 0
        this.onset = 0
        this.events.onStart(this.preRoll, onset)
        this.preRoll = []
        this.preRollLength = 0
      }
      return
    }

    this.onset = 0
  }

  private whileSpeaking(frame: Float32Array, voiced: boolean): void {
    this.events.onFrame(frame, voiced)
    this.silence = voiced ? 0 : this.silence + frame.length
    if (this.silence >= END_PAUSE) {
      this.speaking = false
      this.events.onEnd()
    }
  }
}

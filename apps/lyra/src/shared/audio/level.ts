/**
 * Slow automatic gain for what Lyra judges (speech or not, the user's own voice), in place of
 * the browser's AGC.
 *
 * The microphone is captured raw (capture.ts): Chromium's noise suppression and gain control
 * change the voice in ways that cost Whisper accuracy, and their gain moved under the echo gate
 * and the voice detector. But a raw quiet mic (a headset far from the mouth, a remote voice with
 * the volume down) would sit under the voice detector's thresholds. This brings each track's
 * speech to one level, measured, not guessed: the loud end of the last few seconds (speech, when
 * anyone talks), held when the track is only noise, with the gain moving at most 1 dB a frame so
 * it never pumps. Only the copy that is judged is levelled: recordings and Whisper get the audio
 * as captured.
 */

/** Active speech level aimed for, as RMS (-26 dBFS, the usual level for speech in telephony). */
const TARGET_RMS = 0.05
const MAX_GAIN = 31.6 // +30 dB
const MIN_GAIN = 0.25 // -12 dB
/** Frames of history: ~8 s at 32 ms frames. */
const WINDOW = 250
/** The speech level is this quantile of the window; the noise floor this one. */
const SPEECH_QUANTILE = 0.9
const NOISE_QUANTILE = 0.1
/** The loud end must be this far above the floor (12 dB) to be speech rather than steady noise. */
const SPEECH_OVER_NOISE = 4
const BIN_DB = 1
const MIN_DB = -100
const BINS = 100
/** Largest gain change per frame, in dB. */
const SLEW_DB = 1
const PEAK_LIMIT = 0.98

const toDb = (value: number): number => 20 * Math.log10(Math.max(value, 1e-5))

export type LevelStats = { gainDb: number; speechDb: number | null }

export class LevelNormalizer {
  private readonly histogram = new Uint16Array(BINS)
  private readonly recent: number[] = []
  private gain = 1
  private speechDb: number | null = null

  /** The frame at the normalized level (a new array); `rms` is the frame's own RMS. */
  apply(frame: Float32Array, rms: number): Float32Array {
    this.observe(rms)
    const wanted = this.speechDb === null ? this.gain : this.clampGain(TARGET_RMS / 10 ** (this.speechDb / 20))
    const step = 10 ** (SLEW_DB / 20)
    this.gain = Math.min(this.gain * step, Math.max(this.gain / step, wanted))
    let peak = 0
    for (const sample of frame) peak = Math.max(peak, Math.abs(sample))
    // Never clip: a loud frame gets less gain, just for itself.
    const gain = peak * this.gain > PEAK_LIMIT ? PEAK_LIMIT / Math.max(peak, 1e-9) : this.gain
    const out = new Float32Array(frame.length)
    for (let i = 0; i < frame.length; i++) out[i] = (frame[i] ?? 0) * gain
    return out
  }

  stats(): LevelStats {
    return {
      gainDb: +toDb(this.gain).toFixed(1),
      speechDb: this.speechDb === null ? null : +this.speechDb.toFixed(1)
    }
  }

  private clampGain(gain: number): number {
    return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain))
  }

  private observe(rms: number): void {
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor((toDb(rms) - MIN_DB) / BIN_DB)))
    this.recent.push(bin)
    this.histogram[bin] = (this.histogram[bin] ?? 0) + 1
    if (this.recent.length > WINDOW) {
      const old = this.recent.shift() ?? 0
      this.histogram[old] = Math.max(0, (this.histogram[old] ?? 0) - 1)
    }
    if (this.recent.length < WINDOW / 4) return
    const speech = this.quantile(SPEECH_QUANTILE)
    const noise = this.quantile(NOISE_QUANTILE)
    // Only noise in the window: keep the gain the last speech set.
    if (speech - noise < toDb(SPEECH_OVER_NOISE)) return
    this.speechDb = speech
  }

  private quantile(q: number): number {
    const target = q * this.recent.length
    let seen = 0
    for (let bin = 0; bin < BINS; bin++) {
      seen += this.histogram[bin] ?? 0
      if (seen >= target) return MIN_DB + (bin + 0.5) * BIN_DB
    }
    return MIN_DB + BINS * BIN_DB
  }
}

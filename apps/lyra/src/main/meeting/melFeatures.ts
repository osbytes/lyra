/**
 * Log-mel features for the speaker-activity model (`speakerActivity.ts`), computed the way the
 * model was trained on them: pre-emphasis, a 25 ms Hann window every 10 ms inside a 512-point
 * transform centred on the frame, 128 Slaney mel bands, natural log. Pure, so it's unit-tested;
 * a model fed features that are slightly off still answers, only worse.
 */

export const MEL_SAMPLE_RATE = 16000
export const MEL_HOP = 160
export const MEL_BANDS = 128
const WINDOW = 400
const TRANSFORM = 512
const PRE_EMPHASIS = 0.97
/** Added before the log so silence is a large negative number instead of minus infinity. */
const LOG_GUARD = 2 ** -24

const BINS = TRANSFORM / 2 + 1
/** Slaney's mel scale: linear to 1 kHz, logarithmic above. */
const LINEAR_HZ_PER_MEL = 200 / 3
const LOG_STEP = Math.log(6.4) / 27

export const hzToMel = (hz: number): number =>
  hz < 1000 ? hz / LINEAR_HZ_PER_MEL : 15 + Math.log(hz / 1000) / LOG_STEP

export const melToHz = (mel: number): number =>
  mel < 15 ? mel * LINEAR_HZ_PER_MEL : 1000 * Math.exp(LOG_STEP * (mel - 15))

/** Triangular filters over the transform's bins, each scaled to unit area (Slaney's norm). */
function melFilters(): Float32Array[] {
  const top = hzToMel(MEL_SAMPLE_RATE / 2)
  const edge = (index: number): number => melToHz((top * index) / (MEL_BANDS + 1))
  return Array.from({ length: MEL_BANDS }, (_, band) => {
    const low = edge(band)
    const peak = edge(band + 1)
    const high = edge(band + 2)
    const scale = 2 / (high - low)
    return Float32Array.from({ length: BINS }, (_, bin) => {
      const hz = (bin * MEL_SAMPLE_RATE) / TRANSFORM
      return Math.max(0, Math.min((hz - low) / (peak - low), (high - hz) / (high - peak))) * scale
    })
  })
}

/** In-place radix-2 Fourier transform; the length is a power of two. */
function transform(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const r = real[i] ?? 0
      real[i] = real[j] ?? 0
      real[j] = r
      const m = imaginary[i] ?? 0
      imaginary[i] = imaginary[j] ?? 0
      imaginary[j] = m
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < length / 2; k++) {
        const cos = Math.cos(angle * k)
        const sin = Math.sin(angle * k)
        const a = start + k
        const b = a + length / 2
        const br = real[b] ?? 0
        const bi = imaginary[b] ?? 0
        const xr = br * cos - bi * sin
        const xi = br * sin + bi * cos
        const ar = real[a] ?? 0
        const ai = imaginary[a] ?? 0
        real[b] = ar - xr
        imaginary[b] = ai - xi
        real[a] = ar + xr
        imaginary[a] = ai + xi
      }
    }
  }
}

export type MelFeatures = {
  /** `frames` rows of `MEL_BANDS` values, row after row. */
  data: Float32Array
  /** One frame per 10 ms. The last one reaches past the audio and is left at zero, as in training. */
  frames: number
}

export function logMel(audio: Float32Array): MelFeatures {
  const filters = melFilters()
  const window = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)))
  const whole = Math.floor(audio.length / MEL_HOP)
  const frames = whole + 1
  const data = new Float32Array(frames * MEL_BANDS)
  const emphasized = (index: number): number => {
    if (index < 0 || index >= audio.length) return 0
    const sample = audio[index] ?? 0
    return index === 0 ? sample : sample - PRE_EMPHASIS * (audio[index - 1] ?? 0)
  }
  const real = new Float64Array(TRANSFORM)
  const imaginary = new Float64Array(TRANSFORM)
  const power = new Float32Array(BINS)
  // The window sits in the middle of the transform, which is centred on the frame's first sample.
  const inset = (TRANSFORM - WINDOW) / 2
  for (let frame = 0; frame < whole; frame++) {
    real.fill(0)
    imaginary.fill(0)
    const first = frame * MEL_HOP - TRANSFORM / 2 + inset
    for (let i = 0; i < WINDOW; i++) real[inset + i] = emphasized(first + i) * (window[i] ?? 0)
    transform(real, imaginary)
    for (let bin = 0; bin < BINS; bin++) {
      const r = real[bin] ?? 0
      const m = imaginary[bin] ?? 0
      power[bin] = r * r + m * m
    }
    filters.forEach((filter, band) => {
      let sum = 0
      for (let bin = 0; bin < BINS; bin++) sum += (filter[bin] ?? 0) * (power[bin] ?? 0)
      data[frame * MEL_BANDS + band] = Math.log(sum + LOG_GUARD)
    })
  }
  return { data, frames }
}

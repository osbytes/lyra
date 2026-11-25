import { Fft } from './fft'

/**
 * Acoustic echo canceller for calls on speakers: removes what the system track (the far end)
 * plays into the room from the mic track, so the far end isn't transcribed twice and the user can
 * talk over them without being gated away.
 *
 * A partitioned-block frequency-domain adaptive filter (overlap-save), the linear stage of
 * Speex's MDF and WebRTC's AEC: the room's echo path is learned as a filter on the system track,
 * and its output is subtracted from the mic. The step size follows MDF: a fixed step until the
 * filter has heard enough of the far end, then the share of the error that is still echo (the
 * "leak"), so near-end speech (double talk) slows adaptation instead of wrecking the filter.
 *
 * Linear only: a laptop speaker's distortion leaves a residual, which `EchoGate` (after this)
 * suppresses. Both tracks come from one AudioContext, so they are sample-aligned and the echo
 * always trails the reference; the filter covers up to TAIL_MS of delay plus reverberation.
 */

const BLOCK = 256
const SIZE = BLOCK * 2
const BINS = SIZE / 2 + 1
/** Echo delay plus reverberation the filter covers: Windows audio paths add 50–150 ms. */
const TAIL_MS = 400
const PARTITIONS = Math.ceil((TAIL_MS / 1000) * 16000 / BLOCK)
/** Step before the filter has converged, and the most it ever takes. */
const START_STEP = 0.5
const MAX_STEP = 0.5
/** Far-end blocks with this much power per bin are worth learning from. */
const FAR_ACTIVE_POWER = 1e-3
/** MDF's floor on the leak estimate, so the filter never stops tracking a changing room. */
const MIN_LEAK = 0.005
/** Smoothing of the leak statistics, per block (MDF uses 0.35 / partitions). */
const LEAK_SMOOTHING = 0.35 / PARTITIONS
const EPS = 1e-6

export type EchoCancellerStats = {
  /** Echo return loss enhancement while only the far end talks, in dB (higher is better). */
  erleDb: number
  /** Share of the echo estimate that the leak says remains in the output (0–1). */
  leak: number
  adapted: boolean
  /** Times the background filter went wrong and started again from the foreground. */
  resets: number
  /** Times the background filter proved better and became the output. */
  copies: number
}

export class EchoCanceller {
  private readonly fft = new Fft(SIZE)
  /** The background filter, which adapts: one spectrum per partition. */
  private readonly wRe = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  private readonly wIm = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  /**
   * The foreground filter, which makes the output: the background is copied here only once it
   * removes clearly more than this does, so a filter thrown off by double talk or a changing room
   * never reaches the transcript (MDF's two-path scheme). It starts empty: the raw mic.
   */
  private readonly fRe = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  private readonly fIm = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  /** Far-end spectra, newest first. */
  private readonly xRe = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  private readonly xIm = Array.from({ length: PARTITIONS }, () => new Float64Array(BINS))
  private readonly farPower = new Float64Array(BINS)
  private readonly lastFar = new Float64Array(BLOCK)
  private readonly re = new Float64Array(SIZE)
  private readonly im = new Float64Array(SIZE)
  private readonly yRe = new Float64Array(BINS)
  private readonly yIm = new Float64Array(BINS)
  private readonly errorPower = new Float64Array(BINS)
  private readonly echoPower = new Float64Array(BINS)
  private readonly errorMean = new Float64Array(BINS)
  private readonly echoMean = new Float64Array(BINS)
  private pey = 0
  private pyy = 1
  private leak = 1
  private adapted = false
  private learned = 0
  private constrainNext = 0
  /** Smoothed error energy of each filter while the far end talks. */
  private backgroundError = 0
  private foregroundError = 0
  private resets = 0
  private copies = 0
  /** Mic and output power over far-end-only blocks, for ERLE. */
  private erleIn = 0
  private erleOut = 0

  /** The mic frame with the far end's echo removed; frames are any multiple of BLOCK samples. */
  process(mic: Float32Array, far: Float32Array): Float32Array {
    const out = new Float32Array(mic.length)
    for (let at = 0; at + BLOCK <= mic.length; at += BLOCK) {
      this.block(mic.subarray(at, at + BLOCK), far.subarray(at, at + BLOCK), out.subarray(at, at + BLOCK))
    }
    return out
  }

  stats(): EchoCancellerStats {
    const erle = this.erleOut > 0 ? 10 * Math.log10(this.erleIn / this.erleOut) : 0
    return {
      erleDb: +erle.toFixed(1),
      leak: +this.leak.toFixed(3),
      adapted: this.adapted,
      resets: this.resets,
      copies: this.copies
    }
  }

  private block(mic: Float32Array, far: Float32Array, out: Float32Array): void {
    this.pushFar(far)
    const farActive = this.farActivity() > FAR_ACTIVE_POWER

    const background = this.estimate(this.wRe, this.wIm)
    const foreground = this.estimate(this.fRe, this.fIm)
    let micEnergy = 0
    let backgroundEnergy = 0
    let foregroundEnergy = 0
    let echoEnergy = 0
    let errorEcho = 0
    for (let i = 0; i < BLOCK; i++) {
      const d = mic[i] ?? 0
      const y = background[i] ?? 0
      const eb = d - y
      const ef = d - (foreground[i] ?? 0)
      out[i] = ef > 1 ? 1 : ef < -1 ? -1 : ef
      micEnergy += d * d
      backgroundEnergy += eb * eb
      foregroundEnergy += ef * ef
      echoEnergy += y * y
      errorEcho += eb * y
    }
    if (!farActive) return

    this.erleIn += micEnergy
    this.erleOut += foregroundEnergy
    this.backgroundError = 0.9 * this.backgroundError + 0.1 * backgroundEnergy
    this.foregroundError = 0.9 * this.foregroundError + 0.1 * foregroundEnergy
    if (this.backgroundError < 0.7 * this.foregroundError) {
      this.copyFilter(this.wRe, this.wIm, this.fRe, this.fIm)
      this.foregroundError = this.backgroundError
      this.copies++
    } else if (this.backgroundError > 4 * this.foregroundError + 1e-6) {
      this.copyFilter(this.fRe, this.fIm, this.wRe, this.wIm)
      this.backgroundError = this.foregroundError
      this.pey = 0
      this.pyy = 1
      this.resets++
      return
    }

    // Error and echo-estimate spectra of the background filter, zero-padded at the front as
    // overlap-save needs.
    this.re.fill(0)
    this.im.fill(0)
    for (let i = 0; i < BLOCK; i++) this.re[BLOCK + i] = (mic[i] ?? 0) - (background[i] ?? 0)
    this.fft.transform(this.re, this.im)
    const eRe = this.re.slice(0, BINS)
    const eIm = this.im.slice(0, BINS)
    this.re.fill(0)
    this.im.fill(0)
    for (let i = 0; i < BLOCK; i++) this.re[BLOCK + i] = background[i] ?? 0
    this.fft.transform(this.re, this.im)
    for (let k = 0; k < BINS; k++) {
      this.errorPower[k] = (eRe[k] ?? 0) ** 2 + (eIm[k] ?? 0) ** 2
      this.echoPower[k] = (this.re[k] ?? 0) ** 2 + (this.im[k] ?? 0) ** 2
    }
    this.updateLeak()
    let farEnergy = 0
    for (const sample of far) farEnergy += sample * sample
    this.adapt(eRe, eIm, this.residualRatio(farEnergy, backgroundEnergy, echoEnergy, errorEcho))
  }

  /**
   * MDF's residual-to-error ratio: the share of the error that is still echo, from the leak and
   * from how much the error correlates with the echo estimate (high early on, when the filter has
   * barely started). It floors the per-bin step so the filter keeps learning.
   */
  private residualRatio(farEnergy: number, errorEnergy: number, echoEnergy: number, errorEcho: number): number {
    const see = errorEnergy + 1e-9
    let ratio = (0.0001 * farEnergy + 3 * this.leak * echoEnergy) / see
    ratio = Math.max(ratio, (errorEcho * errorEcho) / (1e-9 + see * echoEnergy))
    return Math.min(ratio, 0.5)
  }

  /** A filter's echo estimate for this block: the sum over partitions of filter × far end. */
  private estimate(wRe: readonly Float64Array[], wIm: readonly Float64Array[]): Float64Array {
    this.yRe.fill(0)
    this.yIm.fill(0)
    for (let p = 0; p < PARTITIONS; p++) {
      const wr = wRe[p]
      const wi = wIm[p]
      const xr = this.xRe[p]
      const xi = this.xIm[p]
      if (!wr || !wi || !xr || !xi) continue
      for (let k = 0; k < BINS; k++) {
        const a = xr[k] ?? 0
        const b = xi[k] ?? 0
        const c = wr[k] ?? 0
        const d = wi[k] ?? 0
        this.yRe[k] = (this.yRe[k] ?? 0) + a * c - b * d
        this.yIm[k] = (this.yIm[k] ?? 0) + a * d + b * c
      }
    }
    this.loadSpectrum(this.yRe, this.yIm)
    this.fft.transform(this.re, this.im, true)
    // Overlap-save: the last BLOCK samples are the linear convolution.
    return this.re.slice(BLOCK, SIZE)
  }

  private copyFilter(
    fromRe: readonly Float64Array[],
    fromIm: readonly Float64Array[],
    toRe: readonly Float64Array[],
    toIm: readonly Float64Array[]
  ): void {
    for (let p = 0; p < PARTITIONS; p++) {
      const re = fromRe[p]
      const im = fromIm[p]
      if (re) toRe[p]?.set(re)
      if (im) toIm[p]?.set(im)
    }
  }

  /** Shifts the far end along by one block and adds the new partition's spectrum. */
  private pushFar(far: Float32Array): void {
    const oldRe = this.xRe.pop()
    const oldIm = this.xIm.pop()
    if (!oldRe || !oldIm) return
    for (let i = 0; i < BLOCK; i++) {
      this.re[i] = this.lastFar[i] ?? 0
      this.re[BLOCK + i] = far[i] ?? 0
      this.lastFar[i] = far[i] ?? 0
    }
    this.im.fill(0)
    this.fft.transform(this.re, this.im)
    for (let k = 0; k < BINS; k++) {
      oldRe[k] = this.re[k] ?? 0
      oldIm[k] = this.im[k] ?? 0
    }
    this.xRe.unshift(oldRe)
    this.xIm.unshift(oldIm)
    // The normalizer is the far-end power over the whole filter, smoothed.
    for (let k = 0; k < BINS; k++) {
      let sum = 0
      for (let p = 0; p < PARTITIONS; p++) {
        const r = this.xRe[p]?.[k] ?? 0
        const i = this.xIm[p]?.[k] ?? 0
        sum += r * r + i * i
      }
      this.farPower[k] = 0.7 * (this.farPower[k] ?? 0) + 0.3 * sum
    }
  }

  private farActivity(): number {
    const r = this.xRe[0]
    const i = this.xIm[0]
    if (!r || !i) return 0
    let sum = 0
    for (let k = 0; k < BINS; k++) sum += (r[k] ?? 0) ** 2 + (i[k] ?? 0) ** 2
    return sum / BINS
  }

  /** MDF's leak: how much of the error power moves with the echo estimate's power. */
  private updateLeak(): void {
    let pey = 0
    let pyy = 0
    for (let k = 0; k < BINS; k++) {
      const e = this.errorPower[k] ?? 0
      const y = this.echoPower[k] ?? 0
      this.errorMean[k] = 0.95 * (this.errorMean[k] ?? 0) + 0.05 * e
      this.echoMean[k] = 0.95 * (this.echoMean[k] ?? 0) + 0.05 * y
      const de = e - (this.errorMean[k] ?? 0)
      const dy = y - (this.echoMean[k] ?? 0)
      pey += de * dy
      pyy += dy * dy
    }
    this.pey = (1 - LEAK_SMOOTHING) * this.pey + LEAK_SMOOTHING * pey
    this.pyy = Math.max(1e-9, (1 - LEAK_SMOOTHING) * this.pyy + LEAK_SMOOTHING * pyy)
    const pey2 = Math.min(Math.max(this.pey, MIN_LEAK * this.pyy), this.pyy)
    this.leak = pey2 / this.pyy
  }

  private adapt(eRe: Float64Array, eIm: Float64Array, residualRatio: number): void {
    this.learned++
    if (!this.adapted && this.learned > PARTITIONS * 2 && this.leak > 0.03) this.adapted = true
    for (let k = 0; k < BINS; k++) {
      const e = (this.errorPower[k] ?? 0) + EPS
      const residual = 0.7 * this.leak * (this.echoPower[k] ?? 0) + 0.3 * residualRatio * e
      const step = this.adapted ? Math.min(MAX_STEP, residual / e) : START_STEP
      const g = step / ((this.farPower[k] ?? 0) + EPS)
      const er = (eRe[k] ?? 0) * g
      const ei = (eIm[k] ?? 0) * g
      for (let p = 0; p < PARTITIONS; p++) {
        const wr = this.wRe[p]
        const wi = this.wIm[p]
        const xr = this.xRe[p]?.[k] ?? 0
        const xi = this.xIm[p]?.[k] ?? 0
        if (!wr || !wi) continue
        // W += step · conj(X) · E / power
        wr[k] = (wr[k] ?? 0) + xr * er + xi * ei
        wi[k] = (wi[k] ?? 0) + xr * ei - xi * er
      }
    }
    this.constrain(this.constrainNext)
    this.constrainNext = (this.constrainNext + 1) % PARTITIONS
  }

  /**
   * Keeps one partition a linear filter (its impulse response no longer than a block), one per
   * block in turn as MDF does: without it the frequency-domain update aliases in time.
   */
  private constrain(p: number): void {
    const wr = this.wRe[p]
    const wi = this.wIm[p]
    if (!wr || !wi) return
    this.loadSpectrum(wr, wi)
    this.fft.transform(this.re, this.im, true)
    for (let i = BLOCK; i < SIZE; i++) this.re[i] = 0
    this.im.fill(0)
    this.fft.transform(this.re, this.im)
    for (let k = 0; k < BINS; k++) {
      wr[k] = this.re[k] ?? 0
      wi[k] = this.im[k] ?? 0
    }
  }

  /** Fills the FFT buffers with a half spectrum and its mirror, for an inverse to real samples. */
  private loadSpectrum(specRe: Float64Array, specIm: Float64Array): void {
    for (let k = 0; k < BINS; k++) {
      this.re[k] = specRe[k] ?? 0
      this.im[k] = specIm[k] ?? 0
    }
    for (let k = BINS; k < SIZE; k++) {
      this.re[k] = specRe[SIZE - k] ?? 0
      this.im[k] = -(specIm[SIZE - k] ?? 0)
    }
  }
}

/**
 * In-place radix-2 complex FFT on separate real and imaginary arrays, for the echo canceller.
 * Small and allocation-free per call: the twiddles and bit reversal are computed once per size.
 */
export class Fft {
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly reversed: Uint32Array

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two: ${String(size)}`)
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size)
    }
    this.reversed = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reversed[i] = r
    }
  }

  /** Forward transform; `inverse` conjugates the twiddles and scales by 1/size. */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i] ?? i
      if (j > i) {
        const tr = re[i] ?? 0
        re[i] = re[j] ?? 0
        re[j] = tr
        const ti = im[i] ?? 0
        im[i] = im[j] ?? 0
        im[j] = ti
      }
    }
    const sign = inverse ? -1 : 1
    for (let half = 1; half < n; half *= 2) {
      const step = n / (half * 2)
      for (let start = 0; start < n; start += half * 2) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step] ?? 1
          const wi = sign * (this.sin[k * step] ?? 0)
          const a = start + k
          const b = a + half
          const br = re[b] ?? 0
          const bi = im[b] ?? 0
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          const ar = re[a] ?? 0
          const ai = im[a] ?? 0
          re[b] = ar - tr
          im[b] = ai - ti
          re[a] = ar + tr
          im[a] = ai + ti
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] = (re[i] ?? 0) / n
        im[i] = (im[i] ?? 0) / n
      }
    }
  }
}

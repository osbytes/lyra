import { describe, expect, it } from 'vitest'
import { MEL_BANDS, MEL_SAMPLE_RATE, hzToMel, logMel, melToHz } from './melFeatures'

describe('mel scale', () => {
  it('is linear to 1 kHz and logarithmic above (Slaney)', () => {
    // 1000 Hz / (200 / 3 Hz per mel) = 15 mel; 6400 Hz is 27 log steps above that.
    expect(hzToMel(1000)).toBeCloseTo(15, 6)
    expect(hzToMel(6400)).toBeCloseTo(42, 6)
    expect(melToHz(42)).toBeCloseTo(6400, 3)
    expect(melToHz(7.5)).toBeCloseTo(500, 6)
  })
})

describe('logMel', () => {
  it('gives one frame per 10 ms and leaves the frame past the audio at zero', () => {
    const { data, frames } = logMel(new Float32Array(MEL_SAMPLE_RATE))
    expect(frames).toBe(101)
    expect(data).toHaveLength(101 * MEL_BANDS)
    // Silence: log(0 + 2^-24) = -24 ln 2.
    expect(data[0]).toBeCloseTo(-24 * Math.LN2, 4)
    expect(data[99 * MEL_BANDS + 5]).toBeCloseTo(-24 * Math.LN2, 4)
    expect(data[100 * MEL_BANDS]).toBe(0)
  })

  it('puts a pure tone in the band around its pitch', () => {
    // 128 bands over 0-8 kHz: the top is hzToMel(8000) = 15 + ln(8) / (ln(6.4) / 27) = 45.245 mel,
    // so band centres are 45.245 / 129 = 0.3507 mel apart and 1 kHz (15 mel) is nearest centre
    // 43 (15.08 mel), which is band 42.
    const tone = Float32Array.from({ length: MEL_SAMPLE_RATE }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / MEL_SAMPLE_RATE))
    const { data } = logMel(tone)
    const frame = Array.from(data.subarray(50 * MEL_BANDS, 51 * MEL_BANDS))
    expect(frame.indexOf(Math.max(...frame))).toBe(42)
  })
})

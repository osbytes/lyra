// Acoustics for synthetic eval audio: rooms, laptop-speaker bleed and music, seeded so a
// scenario is the same audio on every run.
const { RATE } = require('./wav.cjs')

/** Small seeded PRNG, so a scenario is the same audio on every run. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function addAt(target, source, at, gain = 1) {
  for (let i = 0; i < source.length && at + i < target.length; i++) target[at + i] += source[i] * gain
}

/** What the mic hears from laptop speakers: late, duller, with a little room. */
function speakerBleed(remote, gain) {
  const out = new Float32Array(remote.length)
  // One-pole low-pass: laptop speakers and the room eat the highs.
  let state = 0
  const dull = new Float32Array(remote.length)
  for (let i = 0; i < remote.length; i++) {
    state += 0.35 * (remote[i] - state)
    dull[i] = state
  }
  for (const [delayMs, tap] of [[30, 1], [70, 0.35], [130, 0.15]]) {
    addAt(out, dull, Math.round((delayMs / 1000) * RATE), gain * tap)
  }
  return out
}

/** Reverberation time of a furnished office or meeting room, in seconds. */
const RT60 = 0.5

/**
 * A small Schroeder reverb (four combs into two all-passes): what a room adds between a talker
 * and a desk mic. `wet` is how much of the sound is room rather than direct path. Each comb's
 * feedback is set so its echoes fall 60 dB in RT60.
 */
function reverb(dry, wet, rt60 = RT60) {
  const combs = [1557, 1617, 1491, 1422].map((delay) => [delay, 10 ** ((-3 * delay) / RATE / rt60)])
  const out = new Float32Array(dry.length)
  for (const [delay, feedback] of combs) {
    const line = new Float32Array(delay)
    for (let i = 0, j = 0; i < dry.length; i++, j = (j + 1) % delay) {
      const echo = line[j]
      line[j] = dry[i] + echo * feedback
      out[i] += echo / combs.length
    }
  }
  for (const [delay, gain] of [[225, 0.5], [556, 0.5]]) {
    const line = new Float32Array(delay)
    for (let i = 0, j = 0; i < out.length; i++, j = (j + 1) % delay) {
      const delayed = line[j]
      const input = out[i]
      line[j] = input + delayed * gain
      out[i] = delayed - input * gain
    }
  }
  return dry.map((value, i) => value * (1 - wet) + out[i] * wet * 2)
}

/**
 * Background music, as something playing on the computer during a session: a looping chord
 * progression of soft harmonic tones over a kick on every beat. Peak about 0.5.
 */
function music(length, rand) {
  const out = new Float32Array(length)
  const beat = Math.round((60 / 100) * RATE)
  const chords = [
    [261.6, 329.6, 392.0],
    [196.0, 246.9, 293.7],
    [220.0, 261.6, 329.6],
    [174.6, 220.0, 261.6]
  ]
  for (let i = 0; i < length; i++) {
    const t = i / RATE
    const chord = chords[Math.floor(i / (beat * 4)) % chords.length]
    let value = 0
    for (const f of chord) for (const [h, g] of [[1, 1], [2, 0.4], [3, 0.2]]) value += g * Math.sin(2 * Math.PI * f * h * t)
    const sinceBeat = (i % beat) / RATE
    value = value * 0.06 + Math.sin(2 * Math.PI * 55 * sinceBeat) * Math.exp(-sinceBeat * 18) * 0.25
    out[i] = value + (rand() - 0.5) * 0.02 * Math.exp(-sinceBeat * 30)
  }
  return out
}

module.exports = { RT60, addAt, music, random, reverb, speakerBleed }

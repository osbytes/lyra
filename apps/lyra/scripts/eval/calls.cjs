// Synthetic call recordings with exact ground truth, for the failures real calls showed:
//
// - Speaker bleed: on laptop speakers the remote voice plays into the mic, about as loud as
//   the system track and a few tens of ms late. Mixing the tracks then hears the remote person
//   twice, and mic-vs-system energy can't tell them apart.
// - A hot system track that clips.
// - Lopsided calls: the local person talks for minutes and the remote person gets a few lines,
//   which a voice-per-window labeler folds into the local speaker.
// - Quick back-and-forth ("Yeah." "It is.") inside one 20–30 s window, and crosstalk.
// - Two people who sound alike. The two stock TTS voices differ so much that clustering always
//   splits them, so the `similar` scenarios voice both people with one voice, pitch-shifted.
//
// - One far-field mic in a room (a webcam on the desk): both people are reverberant, the far one
//   quieter and more so, and the session runs for minutes. Live identification that drifts merges
//   everyone into one speaker over a long session even when the first minute looked right.
//
// Voice 0 is the local person (mic), voice 1 the remote person (system track) or, in the
// in-room scenario, a second person at the same mic. The audio is generated, never recorded,
// so scenarios are safe to share. Written to <dataDir>/calls/<scenario>/.

const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { render } = require('./tts.cjs')
const { RATE, readWav, writeWav } = require('./wav.cjs')

const L = 'local'
const R = 'remote'

/** Lines are [who, text] or [who, text, { gap, overlap }]: seconds of silence before, or of overlap with, the previous line. */
const LOPSIDED = [
  [L, 'Okay, I think the recording is running now. Let me walk through what changed since last week.'],
  [L, 'The main thing is the new transcript view. Every line has a speaker, and you can rename them as you go.'],
  [L, 'I also moved the settings around, so the model choice is in one place instead of three.'],
  [R, 'Can you hear me okay? I think my audio was cutting out for a second.'],
  [L, 'Yes, you sound fine. So the next part is the release checklist, which still has a few open items.'],
  [L, 'The installer needs a signed build, and we have not tested the update path on a clean machine yet.'],
  [L, 'I would like to get both of those done before Thursday, if we can.'],
  [R, 'That works for me. I can take the clean machine test tomorrow morning.'],
  [L, 'Great. Then I will handle the signing, and we can compare notes after lunch.'],
  [L, 'One more thing. The speaker labels are still mixing us up on calls, so keep an eye on that.'],
  [R, 'Will do. I will send you a recording if it happens again.'],
  [L, 'Perfect. That is everything from me.']
]

const QUICK = [
  [L, 'Did the build finish on your side?'],
  [R, 'Yeah.', { gap: 0.25 }],
  [L, 'And the tests passed?', { gap: 0.25 }],
  [R, 'They did.', { gap: 0.25 }],
  [L, 'Even the slow ones?', { gap: 0.2 }],
  [R, 'All of them.', { gap: 0.2 }],
  [L, 'Nice. Then I will tag the release.', { gap: 0.3 }],
  [R, 'Wait, one second.', { gap: 0.2 }],
  [R, 'I still need to update the changelog before you tag it.', { gap: 0.3 }],
  [L, 'Okay.', { gap: 0.2 }],
  [L, 'Tell me when it is in and I will push the tag right after.', { gap: 0.3 }],
  [R, 'Sure.', { gap: 0.2 }],
  [R, 'Give me five minutes.', { gap: 0.2 }],
  [L, 'Sounds good.', { gap: 0.2 }]
]

const CROSSTALK = [
  [L, 'I was thinking we could ship the meeting notes feature behind a setting first.'],
  [R, 'Right, that is what I was going to say.', { overlap: 0.8 }],
  [L, 'Then we get feedback before turning it on for everyone.', { gap: 0.4 }],
  [R, 'Exactly, and we can watch for complaints about speed.', { overlap: 0.6 }],
  [L, 'Speed is the big one. The local model is slow on older laptops.', { gap: 0.3 }],
  [R, 'Mine takes almost a minute for a short meeting.', { overlap: 1.0 }],
  [L, 'That is too slow. Let us profile it this week.', { gap: 0.4 }],
  [R, 'Agreed.', { overlap: 0.5 }]
]

/** Several minutes of mixed talk: long turns, quick replies and crosstalk, repeated. */
const LONG = [...LOPSIDED, ...QUICK, ...CROSSTALK, ...LOPSIDED.slice(0, 6), ...QUICK.slice(0, 8), ...CROSSTALK.slice(2)]

/**
 * Each scenario: a script and how the two voices reach the two tracks.
 * `remote: 'system'` puts voice 1 on the system track; `'mic'` puts it at the same mic (in-room).
 * `bleed` is the remote voice's gain into the mic through laptop speakers (0 = headphones).
 * `systemGain` above 1 with clipping models a hot system track.
 * `similar` voices the remote person with the local voice, shifted by that much pitch and rate.
 */
const SCENARIOS = {
  'call-headphones': { script: LOPSIDED, remote: 'system', bleed: 0, systemGain: 1 },
  'call-speakers': { script: LOPSIDED, remote: 'system', bleed: 0.9, systemGain: 1 },
  'call-speakers-loud': { script: LOPSIDED, remote: 'system', bleed: 1.1, systemGain: 4 },
  'call-quick-turns': { script: QUICK, remote: 'system', bleed: 0.9, systemGain: 1 },
  'call-crosstalk': { script: CROSSTALK, remote: 'system', bleed: 0.9, systemGain: 1 },
  'room-quick-turns': { script: QUICK, remote: 'mic', bleed: 0, systemGain: 1 },
  'call-similar-voices': { script: LOPSIDED, remote: 'system', bleed: 0.9, systemGain: 3, similar: { pitch: '+15%', rate: '+10%' } },
  'room-similar-voices': { script: QUICK, remote: 'mic', bleed: 0, systemGain: 1, similar: { pitch: '+15%', rate: '+10%' } },
  'room-far-field': { script: LONG, remote: 'mic', bleed: 0, systemGain: 1, room: { near: 0.25, far: 0.5, farGain: 0.45 } },
  'room-far-similar': { script: LONG, remote: 'mic', bleed: 0, systemGain: 1, room: { near: 0.25, far: 0.5, farGain: 0.45 }, similar: { pitch: '+15%', rate: '+10%' } },
  'call-speakers-long': { script: LONG, remote: 'system', bleed: 0.9, systemGain: 1, room: { near: 0.2 } }
}

const GAP = 0.6

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
function reverb(dry, wet) {
  const combs = [1557, 1617, 1491, 1422].map((delay) => [delay, 10 ** ((-3 * delay) / RATE / RT60)])
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

/** Builds one scenario's mic.wav, system.wav (when it has one) and reference. */
function prepare(dataDir, name) {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown call scenario ${name}; use one of ${Object.keys(SCENARIOS).join(', ')}`)
  const dir = join(dataDir, 'calls', name)
  mkdirSync(dir, { recursive: true })
  const clips = render(
    scenario.script.map(([who, text]) =>
      who === L ? { voice: 0, text } : scenario.similar ? { voice: 0, text, ...scenario.similar } : { voice: 1, text }
    ),
    join(dataDir, 'calls', 'clips')
  ).map(readWav)

  // Lay lines on a timeline.
  const placed = []
  let cursor = 0.5
  scenario.script.forEach(([who, text, timing = {}], i) => {
    const start = i === 0 ? cursor : timing.overlap ? cursor - timing.overlap : cursor + (timing.gap ?? GAP)
    const seconds = clips[i].length / RATE
    placed.push({ who, text, start, end: start + seconds, clip: clips[i] })
    cursor = Math.max(cursor, start + seconds)
  })
  const length = Math.ceil((cursor + 1) * RATE)

  let local = new Float32Array(length)
  let remote = new Float32Array(length)
  for (const line of placed) addAt(line.who === L ? local : remote, line.clip, Math.round(line.start * RATE))
  if (scenario.room) {
    local = reverb(local, scenario.room.near)
    // On a call the remote voice reaches the mic through the speakers (`bleed`), not the room.
    if (scenario.remote === 'mic') remote = reverb(remote, scenario.room.far).map((value) => value * scenario.room.farGain)
  }

  // A faint noise floor: real mics are never digital silence, and VAD behaves differently on zeros.
  const noise = random(name.length * 7919)
  const mic = new Float32Array(length)
  // A room is noisier than a headset: fans, the laptop, the street.
  const hiss = scenario.room ? 0.006 : 0.002
  for (let i = 0; i < length; i++) mic[i] = local[i] + (noise() - 0.5) * hiss
  let systemPath = null
  if (scenario.remote === 'mic') {
    addAt(mic, remote, 0)
  } else {
    if (scenario.bleed > 0) addAt(mic, speakerBleed(remote, scenario.bleed), 0)
    const system = remote.map((value) => Math.max(-1, Math.min(1, value * scenario.systemGain)))
    systemPath = join(dir, 'system.wav')
    writeWav(systemPath, system)
  }
  const micPath = join(dir, 'mic.wav')
  writeWav(micPath, mic)

  const reference = {
    segments: placed.map(({ who, text, start, end }) => ({ speaker: who, start: +start.toFixed(3), end: +end.toFixed(3), text }))
  }
  writeFileSync(join(dir, 'reference.json'), JSON.stringify(reference, null, 2))
  return { id: name, wav: micPath, system: systemPath, seconds: length / RATE, reference }
}

module.exports = { SCENARIOS, prepare }

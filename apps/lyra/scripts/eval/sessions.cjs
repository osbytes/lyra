// Realistic multi-speaker sessions with exact ground truth, built from real human speech.
//
// The call scenarios (calls.cjs) use two stock TTS voices, which sound nothing like two people
// at one laptop: embeddings split them trivially, or (pitch-shifted) can't split them at all.
// Real failures are people who sound alike to a speaker model, reaching one desk mic from
// different distances, plus remote people on the system track. So these sessions take read
// speech from LibriSpeech (CC BY 4.0, https://www.openslr.org/12/) and lay it out as a
// conversation, following "From Simulated Mixtures to Simulated Conversations" (Landini et al.,
// Interspeech 2022): turns pass between speakers with short pauses and some overlap, a few people
// talk more than others, listeners drop in short backchannels, and each speaker's seat decides
// the acoustics.
//
// - `mic` people share the desk mic: `near` is the laptop's owner, `mid` across the desk, `far`
//   across the room; each farther seat is quieter and more reverberant.
// - `system` people are remote: encoded and decoded with Opus (as call apps send voice) and
//   levelled onto the system track, and into the mic through laptop speakers with `bleed`.
//
// Corpora (LYRA_SESSIONS_CORPUS): `librispeech` (default; dev-clean + test-clean, 80 speakers,
// ~690 MB once) or `mini` (Mini LibriSpeech, 26 speakers, 126 MB; sex estimated from pitch).
// FLAC and Opus go through ffmpeg (on PATH, or set FFMPEG). Data: <dataDir>/librispeech/;
// sessions: <dataDir>/sessions/<id>/ (sessions-mini/ for the mini corpus). Each session also
// writes enroll.wav: half a minute of the first person's (the laptop owner's) speech that is not
// in the session, for testing a saved voice.
//
// Ids are `<name>` (seed 1) or `<name>.s<k>`: the same id and DATASET_VERSION always give the
// same audio, so results compare across runs; bump DATASET_VERSION when generation changes.

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { addAt, music, random, reverb, speakerBleed } = require('./acoustics.cjs')
const { RATE, readWav, writeWav } = require('./wav.cjs')

/** Bump when anything below changes the audio or references a session id produces. */
const DATASET_VERSION = 2

const CORPORA = {
  librispeech: {
    subsets: ['dev-clean', 'test-clean'],
    urls: (subset) => [`https://www.openslr.org/resources/12/${subset}.tar.gz`, `https://us.openslr.org/resources/12/${subset}.tar.gz`],
    sessions: 'sessions'
  },
  mini: {
    subsets: ['dev-clean-2'],
    urls: (subset) => [`https://www.openslr.org/resources/31/${subset}.tar.gz`, `https://us.openslr.org/resources/31/${subset}.tar.gz`],
    sessions: 'sessions-mini'
  }
}

function corpusName() {
  const name = process.env.LYRA_SESSIONS_CORPUS ?? 'librispeech'
  if (!CORPORA[name]) throw new Error(`LYRA_SESSIONS_CORPUS must be one of ${Object.keys(CORPORA).join(', ')}`)
  return name
}

/** How far a seat is from the desk mic: share of reverberant sound, and level. */
const SEATS = {
  near: { wet: 0.2, gain: 1 },
  mid: { wet: 0.4, gain: 0.6 },
  far: { wet: 0.55, gain: 0.4 }
}

/**
 * Each session: who is where, the room, and how the talk flows.
 * - `people`: seats (near, mid, far) or 'system'. `sex`: 'same' picks everyone of one sex where
 *   the corpus has enough, 'mixed' alternates. `talk` weights how much each person speaks.
 * - `style`: meeting (sentences of any length), quick (short turns, short pauses) or crosstalk
 *   (people talking over each other a third of the time).
 * - `backchannels`: per minute, a listener's short "mm-hm" (the start of one of their sentences)
 *   in the middle of someone else's long turn.
 * - `music` / `video`: something playing on the computer at that level, on the system track and
 *   through the speakers (`bleed`). A video is a stranger talking; it isn't in the reference.
 * - `fan`: a fan or laptop's hum and rush at that level in the room.
 * - `moves`: [person, seat]: that person moves to another seat halfway through.
 */
const SESSIONS = {
  'room-2-desk': { people: ['near', 'mid'], sex: 'same', rt60: 0.4, minutes: 4, talk: [1, 1], backchannels: 2 },
  'room-2-mixed': { people: ['near', 'mid'], sex: 'mixed', rt60: 0.4, minutes: 3, talk: [1, 1] },
  'room-2-music': { people: ['near', 'mid'], sex: 'same', rt60: 0.4, bleed: 0.6, music: 0.6, minutes: 4, talk: [1, 1] },
  'room-2-video': { people: ['near', 'mid'], sex: 'same', rt60: 0.4, bleed: 0.6, video: 0.5, minutes: 4, talk: [1, 1] },
  'room-2-quick': { people: ['near', 'mid'], sex: 'same', rt60: 0.4, minutes: 3, talk: [1, 1], style: 'quick', backchannels: 3 },
  'room-2-crosstalk': { people: ['near', 'mid'], sex: 'same', rt60: 0.4, minutes: 3, talk: [1, 1], style: 'crosstalk', backchannels: 4 },
  'room-2-lopsided': { people: ['near', 'far'], sex: 'same', rt60: 0.5, minutes: 4, talk: [4, 1], backchannels: 3 },
  'room-2-fan': { people: ['near', 'mid'], sex: 'same', rt60: 0.5, fan: 0.02, minutes: 4, talk: [1, 1] },
  'room-2-moving': { people: ['near', 'near'], sex: 'same', rt60: 0.5, moves: [1, 'far'], minutes: 4, talk: [1, 1] },
  'room-3': { people: ['near', 'mid', 'far'], sex: 'same', rt60: 0.5, minutes: 5, talk: [2, 1, 1], backchannels: 2 },
  'room-4-table': { people: ['mid', 'mid', 'far', 'far'], sex: 'mixed', rt60: 0.6, minutes: 5, talk: [1, 1, 1, 1] },
  'room-6-meeting': { people: ['near', 'mid', 'mid', 'far', 'far', 'far'], sex: 'mixed', rt60: 0.6, fan: 0.01, minutes: 8, talk: [2, 2, 1, 1, 1, 1], backchannels: 2 },
  'hybrid-2+1': { people: ['near', 'mid', 'system'], sex: 'same', rt60: 0.4, bleed: 0.9, minutes: 5, talk: [2, 1, 2] },
  'hybrid-2+2': { people: ['near', 'mid', 'system', 'system'], sex: 'mixed', rt60: 0.4, bleed: 0.9, minutes: 5, talk: [1, 1, 1, 1] },
  'call-1+1-quick': { people: ['near', 'system'], sex: 'same', rt60: 0.3, bleed: 0.9, minutes: 3, talk: [1, 1], style: 'quick', backchannels: 3 },
  'call-1+3': { people: ['near', 'system', 'system', 'system'], sex: 'same', rt60: 0.3, bleed: 0, minutes: 5, talk: [2, 1, 1, 1] },
  'meeting-60min': {
    people: ['near', 'mid', 'far', 'system', 'system', 'system'],
    sex: 'mixed',
    rt60: 0.5,
    bleed: 0.9,
    fan: 0.008,
    minutes: 60,
    talk: [3, 2, 1, 2, 1, 1],
    backchannels: 2,
    long: true
  }
}

/** Sessions run by default; `meeting-60min` is long, so it runs only when named. */
const DEFAULT_SESSIONS = Object.keys(SESSIONS).filter((name) => !SESSIONS[name].long)

const STYLES = {
  meeting: { pause: 0.5, overlap: 0.12, keep: 0.2, longest: 14 },
  quick: { pause: 0.25, overlap: 0.18, keep: 0.1, longest: 7 },
  crosstalk: { pause: 0.3, overlap: 0.35, keep: 0.1, longest: 10 }
}

/** Seconds of the first person's speech kept out of the session, for enroll.wav. */
const ENROLL_SECONDS = 30
/** A backchannel is the first this-many seconds of one of the listener's sentences. */
const BACKCHANNEL_SECONDS = [0.35, 0.7]
/** Only turns at least this long get a backchannel in the middle. */
const BACKCHANNEL_TURN_SECONDS = 5
/** The bit rate call apps use for voice. */
const OPUS_BITRATE = '24k'

function ffmpeg() {
  return process.env.FFMPEG ?? 'ffmpeg'
}

function run(args, what) {
  const result = spawnSync(ffmpeg(), ['-loglevel', 'error', '-y', ...args])
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg could not ${what}; install ffmpeg or set FFMPEG (${result.error?.message ?? result.stderr})`)
  }
}

/** Fetches the first of `urls` that answers (curl, which resumes nothing but shows errors). */
function download(urls, path) {
  const failures = []
  for (const url of urls) {
    process.stdout.write(`eval: downloading ${url}\n`)
    const result = spawnSync('curl', ['-sSfL', '-o', `${path}.partial`, url], { stdio: 'inherit' })
    if (result.status === 0) {
      renameSync(`${path}.partial`, path)
      return
    }
    failures.push(url)
  }
  throw new Error(`could not download ${failures.join(', ')}`)
}

/** Total samples from a FLAC file's STREAMINFO block, so durations need no decoding. */
function flacSamples(path) {
  const head = readFileSync(path).subarray(0, 42)
  if (head.toString('ascii', 0, 4) !== 'fLaC') throw new Error(`${path} is not FLAC`)
  return (head[8 + 13] & 0x0f) * 2 ** 32 + head.readUInt32BE(8 + 14)
}

/** Speakers with their sex and utterances (id, FLAC path, text, seconds), sorted for stable picks. */
async function corpus(dataDir) {
  const config = CORPORA[corpusName()]
  const base = join(dataDir, 'librispeech')
  const root = join(base, 'LibriSpeech')
  mkdirSync(base, { recursive: true })
  for (const subset of config.subsets) {
    if (existsSync(join(root, subset))) continue
    const archive = join(base, `${subset}.tar.gz`)
    if (!existsSync(archive)) download(config.urls(subset), archive)
    const result = spawnSync('tar', ['-xzf', archive, '-C', base], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`could not unpack ${archive}`)
    rmSync(archive, { force: true })
  }
  // The full subsets ship SPEAKERS.TXT; the mini one doesn't, so sex comes from pitch there.
  const listed = new Map()
  const speakersFile = join(root, 'SPEAKERS.TXT')
  if (existsSync(speakersFile)) {
    for (const line of readFileSync(speakersFile, 'utf8').split('\n')) {
      if (line.startsWith(';')) continue
      const [id, sex] = line.split('|').map((part) => part.trim())
      if (id && (sex === 'F' || sex === 'M')) listed.set(id, sex)
    }
  }
  const speakers = []
  for (const subset of config.subsets) {
    const dir = join(root, subset)
    for (const id of readdirSync(dir).sort()) {
      const utterances = []
      for (const chapter of readdirSync(join(dir, id)).sort()) {
        const chapterDir = join(dir, id, chapter)
        const lines = readFileSync(join(chapterDir, `${id}-${chapter}.trans.txt`), 'utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          const space = line.indexOf(' ')
          const utt = line.slice(0, space)
          const flac = join(chapterDir, `${utt}.flac`)
          utterances.push({ id: utt, flac, text: line.slice(space + 1).toLowerCase(), seconds: flacSamples(flac) / RATE })
        }
      }
      speakers.push({ id, sex: listed.get(id) ?? '?', utterances })
    }
  }
  if (speakers.some((speaker) => speaker.sex === '?')) {
    const cache = join(base, 'sexes.json')
    const sexes = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : {}
    for (const speaker of speakers) {
      if (speaker.sex !== '?') continue
      sexes[speaker.id] ??= medianPitch(speaker.utterances.slice(0, 3).map((u) => decode(dataDir, u))) > 165 ? 'F' : 'M'
      speaker.sex = sexes[speaker.id]
    }
    writeFileSync(cache, JSON.stringify(sexes, null, 2))
  }
  return speakers
}

/** Median pitch (Hz) over the loud frames of some clips, by autocorrelation in 70–400 Hz. */
function medianPitch(clips) {
  const frame = 640
  const pitches = []
  for (const clip of clips) {
    for (let at = 0; at + frame + RATE / 70 < clip.length; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += clip[i] * clip[i]
      if (energy / frame < 1e-3) continue
      let best = { lag: 0, score: 0 }
      for (let lag = Math.floor(RATE / 400); lag <= Math.ceil(RATE / 70); lag++) {
        let dot = 0
        for (let i = at; i < at + frame; i++) dot += clip[i] * clip[i + lag]
        if (dot / energy > best.score) best = { lag, score: dot / energy }
      }
      if (best.score > 0.5) pitches.push(RATE / best.lag)
    }
  }
  pitches.sort((a, b) => a - b)
  return pitches[Math.floor(pitches.length / 2)] ?? 0
}

/** One utterance as 16 kHz mono floats, decoded once and cached next to the corpus. */
function decode(dataDir, utterance) {
  const dir = join(dataDir, 'librispeech', 'wav')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${utterance.id}.wav`)
  if (!existsSync(out)) run(['-i', utterance.flac, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', out], `decode ${utterance.flac}`)
  return readWav(out)
}

/**
 * A remote voice as a call app delivers it: Opus at a voice bit rate, then levelled by the
 * app's gain control so every remote person arrives at a similar loudness.
 */
function opus(voice, scratch) {
  const input = join(scratch, 'voice.wav')
  const encoded = join(scratch, 'voice.ogg')
  const output = join(scratch, 'voice-out.wav')
  writeWav(input, voice.map((value) => Math.max(-1, Math.min(1, value))))
  run(['-i', input, '-c:a', 'libopus', '-b:a', OPUS_BITRATE, '-application', 'voip', encoded], 'encode Opus')
  run(['-i', encoded, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', output], 'decode Opus')
  const decoded = readWav(output)
  const out = new Float32Array(voice.length)
  out.set(decoded.subarray(0, voice.length))
  let peak = 0
  for (const value of out) peak = Math.max(peak, Math.abs(value))
  const gain = peak > 0 ? 0.5 / peak : 1
  return out.map((value) => value * gain)
}

/** A fan or laptop in the room: low rumble, a little hiss and a mains hum. */
function fan(length, level, rand) {
  const out = new Float32Array(length)
  let brown = 0
  for (let i = 0; i < length; i++) {
    brown = 0.98 * brown + (rand() - 0.5) * 0.2
    const hum = Math.sin((2 * Math.PI * 120 * i) / RATE) * 0.3
    out[i] = (brown + hum + (rand() - 0.5) * 0.3) * level
  }
  return out
}

/** Picks the session's speakers: everyone one sex, or alternating, deterministically by seed. */
function cast(speakers, session, rand, extra = 0) {
  const bySex = (sex) => speakers.filter((speaker) => speaker.sex === sex)
  const shuffled = (list) => list.map((item) => ({ item, key: rand() })).sort((a, b) => a.key - b.key).map(({ item }) => item)
  const count = session.people.length + extra
  if (session.sex === 'same') {
    const sex = rand() < 0.5 ? 'F' : 'M'
    const pool = bySex(sex).length >= count ? bySex(sex) : speakers
    return shuffled(pool).slice(0, count)
  }
  const [a, b] = [shuffled(bySex('F')), shuffled(bySex('M'))]
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? a : b)[Math.floor(i / 2)] ?? speakers[i])
}

/** `name` or `name.s<k>` → the session's settings and seed number. */
function parseId(id) {
  const match = /^(.*)\.s(\d+)$/.exec(id)
  const name = match ? match[1] : id
  const seed = match ? Number(match[2]) : 1
  const session = SESSIONS[name]
  if (!session) throw new Error(`unknown session ${name}; use one of ${Object.keys(SESSIONS).join(', ')}`)
  return { name, seed, session }
}

/** Ids for `names` with `seeds` draws each: seed 1 is the bare name. */
function sessionIds(names = DEFAULT_SESSIONS, seeds = 1) {
  return names.flatMap((name) => Array.from({ length: seeds }, (_, k) => (k === 0 ? name : `${name}.s${k + 1}`)))
}

function sessionDir(dataDir, id) {
  return join(dataDir, CORPORA[corpusName()].sessions, id)
}

/** Builds one session's mic.wav, system.wav, enroll.wav and reference; reuses them if current. */
async function prepare(dataDir, id) {
  const { name, seed, session } = parseId(id)
  const dir = sessionDir(dataDir, id)
  const referencePath = join(dir, 'reference.json')
  const paths = { wav: join(dir, 'mic.wav'), system: join(dir, 'system.wav'), enroll: join(dir, 'enroll.wav') }
  if (existsSync(referencePath)) {
    const existing = JSON.parse(readFileSync(referencePath, 'utf8'))
    if (existing.version === DATASET_VERSION && existing.corpus === corpusName() && existsSync(paths.wav)) {
      return { id, ...paths, seconds: existing.seconds, reference: existing }
    }
  }
  const style = STYLES[session.style ?? 'meeting']
  const rand = random([...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) + seed * 7919 + DATASET_VERSION * 104729)
  const everyone = cast(await corpus(dataDir), session, rand, session.video ? 1 : 0)
  const people = everyone.slice(0, session.people.length)
  const stranger = session.video ? everyone[session.people.length] : null
  mkdirSync(dir, { recursive: true })
  const scratch = join(tmpdir(), `lyra-sessions-${process.pid}`)
  mkdirSync(scratch, { recursive: true })

  // Hold back the first person's first utterances for enrollment; the rest are theirs to say.
  // Short enough for the style; a reader with too few of those gives their shortest instead.
  const queues = people.map((person) => {
    const fits = person.utterances.filter((u) => u.seconds <= style.longest)
    return fits.length >= 12 ? fits : [...person.utterances].sort((a, b) => a.seconds - b.seconds).slice(0, 20)
  })
  const enroll = []
  let enrolled = 0
  while (enrolled < ENROLL_SECONDS && queues[0].length > 0) {
    const utterance = queues[0].shift()
    enroll.push(utterance)
    enrolled += utterance.seconds
  }

  // Turns: mostly to someone else, weighted by how much they talk; sometimes the same person goes on.
  const weights = session.talk
  const placed = []
  let cursor = 0.5
  let current = 0
  while (cursor < session.minutes * 60) {
    if (placed.length > 0 && rand() >= style.keep) {
      const others = weights.map((weight, i) => (i === current ? 0 : weight))
      let pick = rand() * others.reduce((sum, weight) => sum + weight, 0)
      current = others.findIndex((weight) => (pick -= weight) < 0)
    }
    const utterance = queues[current].shift()
    if (!utterance) break
    queues[current].push(utterance)
    const audio = decode(dataDir, utterance)
    const previous = placed.at(-1)
    const overlaps = previous && previous.person !== current && rand() < style.overlap
    const start = !previous
      ? cursor
      : overlaps
        ? previous.end - Math.min(1.5, 0.2 + rand() * 1.2, (previous.end - previous.start) / 2)
        : cursor + style.pause * (0.3 + rand() * 1.4)
    placed.push({ person: current, text: utterance.text, start, end: start + audio.length / RATE, audio })
    cursor = Math.max(cursor, start + audio.length / RATE)
  }
  const length = Math.ceil((cursor + 1) * RATE)

  // Backchannels: a listener's first half-second in the middle of a long turn. Their words are
  // unknown (a sentence cut short), so the reference has their time but no text.
  if (session.backchannels && people.length > 1) {
    const wanted = Math.round((session.backchannels * length) / RATE / 60)
    const long = placed.filter((line) => line.end - line.start >= BACKCHANNEL_TURN_SECONDS && line.text)
    for (let n = 0; n < wanted && long.length; n++) {
      const turn = long[Math.floor(rand() * long.length)]
      let listener = Math.floor(rand() * (people.length - 1))
      if (listener >= turn.person) listener++
      const source = queues[listener][Math.floor(rand() * queues[listener].length)]
      const seconds = BACKCHANNEL_SECONDS[0] + rand() * (BACKCHANNEL_SECONDS[1] - BACKCHANNEL_SECONDS[0])
      const audio = decode(dataDir, source).subarray(0, Math.round(seconds * RATE))
      // Fade out, so the cut doesn't click.
      const faded = audio.map((value, i) => value * Math.min(1, (audio.length - i) / (0.05 * RATE)))
      const start = turn.start + (turn.end - turn.start) * (0.3 + rand() * 0.4)
      placed.push({ person: listener, text: '', start, end: start + faded.length / RATE, audio: faded, backchannel: true })
    }
    placed.sort((a, b) => a.start - b.start)
  }

  // Each person on their own track, then the room and the call between them and the mic.
  const mic = new Float32Array(length)
  const system = new Float32Array(length)
  const levels = people.map(() => 10 ** ((rand() * 6 - 3) / 20))
  const half = Math.floor(length / 2)
  people.forEach((_, i) => {
    let voice = new Float32Array(length)
    for (const line of placed) if (line.person === i) addAt(voice, line.audio, Math.round(line.start * RATE))
    const seat = session.people[i]
    if (seat === 'system') {
      voice = opus(voice, scratch)
      addAt(system, voice, 0)
      if (session.bleed) addAt(mic, speakerBleed(voice, session.bleed), 0)
      return
    }
    const moved = session.moves && session.moves[0] === i ? session.moves[1] : null
    const place = (part, where, at) => {
      const { wet, gain } = SEATS[where]
      addAt(mic, reverb(part, wet, session.rt60), at, gain * levels[i])
    }
    if (!moved) place(voice, seat, 0)
    else {
      place(voice.subarray(0, half), seat, 0)
      place(voice.subarray(half), moved, half)
    }
  })
  if (session.music || stranger) {
    let backdrop
    if (session.music) backdrop = music(length, rand).map((value) => value * session.music)
    else {
      // A video: the stranger reading on and on, as a talk or a show would.
      const track = new Float32Array(length)
      let at = 0
      for (let k = 0; at < length; k = (k + 1) % stranger.utterances.length) {
        const clip = decode(dataDir, stranger.utterances[k])
        addAt(track, clip, at)
        at += clip.length + Math.round(0.4 * RATE)
      }
      backdrop = opus(track, scratch).map((value) => value * session.video)
    }
    addAt(system, backdrop, 0)
    if (session.bleed) addAt(mic, speakerBleed(backdrop, session.bleed), 0)
  }
  if (session.fan) addAt(mic, fan(length, session.fan, rand), 0)
  // Real mics are never digital silence: a room's fans and laptop, and a quieter system floor.
  const hiss = random(length)
  for (let i = 0; i < length; i++) {
    mic[i] = Math.max(-1, Math.min(1, mic[i] + (hiss() - 0.5) * 0.006))
    system[i] = Math.max(-1, Math.min(1, system[i] + (hiss() - 0.5) * 0.0005))
  }
  writeWav(paths.wav, mic)
  writeWav(paths.system, system)

  const enrollParts = enroll.map((utterance) => decode(dataDir, utterance))
  const enrollAudio = new Float32Array(enrollParts.reduce((sum, part) => sum + part.length, 0))
  enrollParts.reduce((offset, part) => (enrollAudio.set(part, offset), offset + part.length), 0)
  writeWav(paths.enroll, reverb(enrollAudio, SEATS.near.wet, session.rt60))
  rmSync(scratch, { recursive: true, force: true })

  const reference = {
    version: DATASET_VERSION,
    corpus: corpusName(),
    session: name,
    seed,
    seconds: length / RATE,
    speakers: people.map((person, i) => ({ speaker: person.id, sex: person.sex, seat: session.people[i] })),
    ...(stranger ? { video: { speaker: stranger.id, sex: stranger.sex } } : {}),
    segments: placed.map(({ person, text, start, end, backchannel }) => ({
      speaker: people[person].id,
      start: +start.toFixed(3),
      end: +end.toFixed(3),
      text,
      ...(backchannel ? { backchannel: true } : {})
    }))
  }
  writeFileSync(referencePath, JSON.stringify(reference, null, 2))
  return { id, ...paths, seconds: length / RATE, reference }
}

module.exports = { DATASET_VERSION, DEFAULT_SESSIONS, SESSIONS, prepare, sessionDir, sessionIds }

// `node scripts/eval/sessions.cjs [names] [--seeds 3]` generates sessions without running the pipeline.
if (require.main === module) {
  const dataDir = process.env.LYRA_EVAL_DATA ?? join(__dirname, '..', '..', 'eval-data')
  const named = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : DEFAULT_SESSIONS
  const seedsAt = process.argv.indexOf('--seeds')
  const seeds = seedsAt === -1 ? 1 : Number(process.argv[seedsAt + 1])
  ;(async () => {
    for (const id of sessionIds(named, seeds)) {
      const { seconds, reference } = await prepare(dataDir, id)
      const voices = reference.speakers.map(({ speaker, sex, seat }) => `${speaker}${sex} ${seat}`).join(', ')
      process.stdout.write(`${id.padEnd(20)} ${(seconds / 60).toFixed(1)} min, ${reference.segments.length} turns: ${voices}\n`)
    }
  })().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

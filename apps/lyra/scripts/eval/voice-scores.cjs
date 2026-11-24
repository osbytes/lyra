// How alike a saved voice is to its owner and to everyone else, per session: the numbers that
// decide when "this speaker is you" can be trusted. For each session (sessions.cjs) it embeds
// enroll.wav (the first person, recorded apart from the session, as a saved voice is) and each
// reference speaker's own speech in the session (overlaps left out, 30 s at most), then prints
// the owner's score next to the best score of anyone else.
//
//   LYRA_MODELS_DIR=<dir> node scripts/eval/voice-scores.cjs [--embedding a.onnx,b.onnx] [--scenarios a,b] [--seeds 3]
//
// Run `pnpm eval:sessions` (or `node scripts/eval/sessions.cjs`) once first.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const sherpa = require('sherpa-onnx-node')
const { DEFAULT_SESSIONS, sessionDir, sessionIds } = require('./sessions.cjs')
const { RATE, readWav } = require('./wav.cjs')

const root = join(__dirname, '..', '..')
const SECONDS = 30

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function cosine(a, b) {
  let dot = 0
  let x = 0
  let y = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    x += a[i] * a[i]
    y += b[i] * b[i]
  }
  return dot / Math.sqrt(x * y)
}

function embed(extractor, samples) {
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: RATE, samples })
  stream.inputFinished()
  return Array.from(extractor.compute(stream, false))
}

/** A speaker's turns with every overlap cut out, joined up to SECONDS. */
function ownSpeech(audio, segments, speaker) {
  const parts = []
  let total = 0
  for (const segment of segments) {
    if (segment.speaker !== speaker || total >= SECONDS * RATE) continue
    const others = segments.filter((other) => other.speaker !== speaker && other.start < segment.end && other.end > segment.start)
    let start = segment.start
    let end = segment.end
    for (const other of others) {
      if (other.start <= start) start = Math.max(start, other.end)
      else end = Math.min(end, other.start)
    }
    if (end - start < 1) continue
    const part = audio.subarray(Math.floor(start * RATE), Math.floor(end * RATE))
    parts.push(part)
    total += part.length
  }
  const joined = new Float32Array(total)
  parts.reduce((offset, part) => (joined.set(part, offset), offset + part.length), 0)
  return joined
}

function main() {
  const models = process.env.LYRA_MODELS_DIR
  if (!models) throw new Error('set LYRA_MODELS_DIR to the folder with the speaker models')
  const dataDir = process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data')
  const names = sessionIds(arg('scenarios', DEFAULT_SESSIONS.join(',')).split(','), Number(arg('seeds', '1')))
  for (const file of arg('embedding', 'wespeaker-en-voxceleb-resnet34-LM.onnx').split(',')) {
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: join(models, file), numThreads: 4 })
    process.stdout.write(`== ${file}\n${'session'.padEnd(18)} owner  others (best)  margin   others, each\n`)
    const owners = []
    const strangers = []
    for (const name of names) {
      const dir = sessionDir(dataDir, name)
      if (!existsSync(join(dir, 'reference.json'))) continue
      const reference = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'))
      const mic = readWav(join(dir, 'mic.wav'))
      const system = readWav(join(dir, 'system.wav'))
      const audio = mic.map((value, i) => Math.max(-1, Math.min(1, value + (system[i] ?? 0))))
      const saved = embed(extractor, readWav(join(dir, 'enroll.wav')))
      const [owner, ...rest] = reference.speakers.map(({ speaker }) => speaker)
      const ownerScore = cosine(saved, embed(extractor, ownSpeech(audio, reference.segments, owner)))
      const others = rest.map((speaker) => cosine(saved, embed(extractor, ownSpeech(audio, reference.segments, speaker))))
      const best = Math.max(...others)
      owners.push(ownerScore)
      strangers.push(...others)
      process.stdout.write(
        `${name.padEnd(18)} ${ownerScore.toFixed(3)}  ${best.toFixed(3)}          ${(ownerScore - best).toFixed(3).padStart(6)}   ${others.map((s) => s.toFixed(2)).join(' ')}\n`
      )
    }
    const low = Math.min(...owners)
    const high = Math.max(...strangers)
    process.stdout.write(`owner lowest ${low.toFixed(3)}, stranger highest ${high.toFixed(3)}: ${low > high ? 'separable' : 'overlap'}\n\n`)
  }
}

main()

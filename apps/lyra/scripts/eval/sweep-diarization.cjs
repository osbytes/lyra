// Diarization alone, over the call scenarios and a range of clustering thresholds: DER and the
// number of speakers found, without Whisper, so tuning takes a minute rather than an eval run.
// Mirrors the speaker worker (src/main/meeting/worker.ts): mic + system mixed, the same
// segmentation and embedding models and durations, tiny speakers folded into the closest.
//
//   LYRA_MODELS_DIR=<dir> node scripts/eval/sweep-diarization.cjs [--thresholds 0.4,0.5,0.6] [--scenarios a,b]
//     [--merge 0.7]   then merge speakers whose voiceprints (30 s of each) are at least this alike.
//                     Tried and rejected: two real people in a room scored 0.95, above a call's
//                     split remote voice (0.93), so any bar that fixes over-splitting merges people.
//     [--embedding file.onnx]   another speaker-embedding model in the models folder
//     [--dataset sessions]      the real-voice sessions (sessions.cjs) instead of the TTS calls
//
// Run `pnpm eval:calls` / `pnpm eval:sessions` once first: they generate the audio into eval-data/.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const sherpa = require('sherpa-onnx-node')
const { der } = require('./metrics.cjs')
const { readWav } = require('./wav.cjs')

const root = join(__dirname, '..', '..')
const RATE = 16000
const MIN_SPEAKER_SECONDS = 2

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function mix(a, b) {
  if (!b) return a
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, (a[i] ?? 0) + (b[i] ?? 0)))
  return out
}

/** Folds speakers with under MIN_SPEAKER_SECONDS into the speaker most often next to them. */
function foldTiny(segments) {
  const talk = new Map()
  for (const s of segments) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start)
  const real = [...talk.entries()].filter(([, t]) => t >= MIN_SPEAKER_SECONDS).map(([id]) => id)
  if (!real.length) return segments
  return segments.map((s, i) => {
    if (real.includes(s.speaker)) return s
    const near = [segments[i - 1], segments[i + 1]].find((n) => n && real.includes(n.speaker))
    return { ...s, speaker: near ? near.speaker : real[0] }
  })
}

const EMBEDDING_SECONDS = 30

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

/** A voiceprint per speaker from their longest segments, as the speaker worker makes them. */
function voiceprints(extractor, audio, segments) {
  const out = new Map()
  for (const speaker of new Set(segments.map((s) => s.speaker))) {
    const own = segments.filter((s) => s.speaker === speaker).sort((a, b) => b.end - b.start - (a.end - a.start))
    const parts = []
    let total = 0
    for (const s of own) {
      if (total >= EMBEDDING_SECONDS * RATE) break
      const part = audio.subarray(Math.floor(s.start * RATE), Math.ceil(s.end * RATE))
      parts.push(part)
      total += part.length
    }
    const joined = new Float32Array(total)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    const stream = extractor.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: joined })
    stream.inputFinished()
    out.set(speaker, Array.from(extractor.compute(stream, false)))
  }
  return out
}

/** Merges the most alike pair of speakers while their voiceprints are at least `bar` alike. */
function mergeAlike(extractor, audio, segments, bar) {
  for (;;) {
    const prints = voiceprints(extractor, audio, segments)
    const ids = [...prints.keys()]
    let best = null
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue
      const score = cosine(prints.get(a), prints.get(b))
      if (score >= bar && (!best || score > best.score)) best = { a, b, score }
    }
    if (!best) return segments
    segments = segments.map((s) => (s.speaker === best.b ? { ...s, speaker: best.a } : s))
  }
}

function main() {
  const models = process.env.LYRA_MODELS_DIR
  if (!models) throw new Error('set LYRA_MODELS_DIR to the folder with the speaker models')
  const dataDir = process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data')
  const thresholds = arg('thresholds', '0.3,0.4,0.5,0.6,0.7').split(',').map(Number)
  const merge = arg('merge', null)
  const embedding = join(models, arg('embedding', 'wespeaker-en-voxceleb-resnet34-LM.onnx'))
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: embedding, numThreads: 2 })
  const dataset = arg('dataset', 'calls')
  const sessions = require('./sessions.cjs')
  const names =
    dataset === 'sessions'
      ? sessions.sessionIds(arg('scenarios', sessions.DEFAULT_SESSIONS.join(',')).split(','), Number(arg('seeds', '1')))
      : arg('scenarios', Object.keys(require('./calls.cjs').SCENARIOS).join(',')).split(',')
  const totals = new Map(thresholds.map((t) => [t, { error: 0, time: 0, right: 0 }]))
  process.stdout.write(`${'scenario'.padEnd(22)}${thresholds.map((t) => `   t=${t.toFixed(2)}     `).join('')}\n`)
  for (const name of names) {
    const dir = dataset === 'sessions' ? sessions.sessionDir(dataDir, name) : join(dataDir, dataset, name)
    if (!existsSync(join(dir, 'reference.json'))) {
      process.stdout.write(`${name}: not generated; run pnpm eval:${dataset} --${dataset === 'calls' ? 'scenarios' : 'sessions'} ${name}\n`)
      continue
    }
    const reference = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'))
    const systemPath = join(dir, 'system.wav')
    const audio = mix(readWav(join(dir, 'mic.wav')), existsSync(systemPath) ? readWav(systemPath) : null)
    const refSpeakers = new Set(reference.segments.map((s) => s.speaker)).size
    let row = name.padEnd(22)
    for (const threshold of thresholds) {
      const diarizer = new sherpa.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: join(models, 'pyannote-segmentation-3.0.onnx') }, numThreads: 2 },
        embedding: { model: embedding, numThreads: 2 },
        clustering: { numClusters: -1, threshold },
        minDurationOn: 0.3,
        minDurationOff: 0.5
      })
      const raw = foldTiny(diarizer.process(audio))
      const segments = merge ? mergeAlike(extractor, audio, raw, Number(merge)) : raw
      const result = der(reference, { segments })
      const found = new Set(segments.map((s) => s.speaker)).size
      const total = totals.get(threshold)
      total.error += result.rate * result.scoredSeconds
      total.time += result.scoredSeconds
      if (found === refSpeakers) total.right++
      row += `  ${(result.rate * 100).toFixed(1).padStart(5)}% ${found}/${refSpeakers}  `
    }
    process.stdout.write(`${row}\n`)
  }
  let row = 'overall DER'.padEnd(22)
  for (const t of thresholds) {
    const total = totals.get(t)
    row += `  ${((total.error / Math.max(1, total.time)) * 100).toFixed(1).padStart(5)}% ${String(total.right).padStart(2)} ok `
  }
  process.stdout.write(`${row}\n`)
  process.stdout.write(`(\`ok\`: scenarios where the speaker count was right; samples at ${RATE} Hz)\n`)
}

main()

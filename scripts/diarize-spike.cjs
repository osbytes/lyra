// Speaker-diarization spike: is sherpa-onnx accurate and fast enough for Lyra meetings?
//
//   node scripts/diarize-spike.cjs --models <dir> --lines <dir>    # synthetic fixture with ground truth
//   node scripts/diarize-spike.cjs --models <dir> --wav <file.wav> # any 16 kHz mono 16-bit WAV
//
// <models> holds segmentation.onnx (pyannote 3.0) and embedding.onnx (speaker embedding).
// <lines> holds line0.wav, line1.wav, … spoken by alternating speakers (A, B, A, …).
// Run under Electron with ELECTRON_RUN_AS_NODE=1 to check the addon loads there too.

const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const sherpa = require('sherpa-onnx-node')

const SAMPLE_RATE = 16000
const GAP_SECONDS = 0.6

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1]
}

/** Reads the PCM16 `data` chunk of a mono WAV into floats. */
function readWav(path) {
  const buf = readFileSync(path)
  let offset = 12
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

function buildFixture(dir) {
  const files = readdirSync(dir)
    .filter((name) => /^line\d+\.wav$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const gap = new Float32Array(Math.round(GAP_SECONDS * SAMPLE_RATE))
  const parts = []
  const truth = []
  let at = 0
  files.forEach((name, index) => {
    const clip = readWav(join(dir, name))
    truth.push({ start: at / SAMPLE_RATE, end: (at + clip.length) / SAMPLE_RATE, speaker: index % 2 })
    parts.push(clip, gap)
    at += clip.length + gap.length
  })
  const samples = new Float32Array(at)
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }
  return { samples, truth, clips: files.map((name) => readWav(join(dir, name))) }
}

/**
 * Scores labels against ground truth with the best label mapping.
 * coverage = right-speaker time / all ground-truth time (pauses inside a turn count as misses);
 * purity   = right-speaker time / time the diarizer labeled at all.
 */
function accuracy(truth, segments) {
  const step = 0.01
  const labelsAt = (list, t) => list.filter((s) => t >= s.start && t < s.end).map((s) => s.speaker)
  const counts = new Map()
  let speech = 0
  let labeled = 0
  for (const turn of truth) {
    for (let t = turn.start; t < turn.end; t += step) {
      speech++
      const [hyp] = labelsAt(segments, t)
      if (hyp === undefined) continue
      labeled++
      const key = `${turn.speaker}:${hyp}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  // Greedy mapping: each true speaker to the predicted label it overlaps most.
  const used = new Set()
  let correct = 0
  for (const speaker of [...new Set(truth.map((t) => t.speaker))]) {
    let best = null
    for (const [key, n] of counts) {
      const [ref, hyp] = key.split(':').map(Number)
      if (ref !== speaker || used.has(hyp)) continue
      if (!best || n > best.n) best = { hyp, n }
    }
    if (best) {
      used.add(best.hyp)
      correct += best.n
    }
  }
  return { coverage: correct / speech, purity: correct / labeled }
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

function embed(extractor, samples) {
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  stream.inputFinished()
  return extractor.compute(stream)
}

const models = arg('models')
if (!models) throw new Error('pass --models <dir>')
const segmentation = join(models, 'segmentation.onnx')
const embedding = join(models, 'embedding.onnx')

const lines = arg('lines')
const wav = arg('wav')
const fixture = lines ? buildFixture(lines) : { samples: readWav(wav), truth: null, clips: [] }
const seconds = fixture.samples.length / SAMPLE_RATE

const diarizer = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: segmentation }, numThreads: 2 },
  embedding: { model: embedding, numThreads: 2 },
  clustering: { numClusters: -1, threshold: 0.5 },
  minDurationOn: 0.3,
  minDurationOff: 0.5
})

const started = performance.now()
const segments = diarizer.process(fixture.samples)
const elapsed = (performance.now() - started) / 1000

console.log(`audio ${seconds.toFixed(1)} s, diarized in ${elapsed.toFixed(2)} s, RTF ${(elapsed / seconds).toFixed(3)}`)
console.log(`speakers found: ${new Set(segments.map((s) => s.speaker)).size}`)
for (const s of segments) console.log(`  ${s.start.toFixed(2)}–${s.end.toFixed(2)}  speaker ${s.speaker}`)

if (fixture.truth) {
  const { coverage, purity } = accuracy(fixture.truth, segments)
  console.log(`coverage ${(coverage * 100).toFixed(1)}%, purity ${(purity * 100).toFixed(1)}%`)

  // Identification: enroll speaker A from one clip, then score every other clip.
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: embedding, numThreads: 2 })
  const enrolled = embed(extractor, fixture.clips[0])
  fixture.clips.slice(1).forEach((clip, i) => {
    const score = cosine(enrolled, embed(extractor, clip))
    console.log(`  clip ${i + 1} (speaker ${(i + 1) % 2 === 0 ? 'A' : 'B'}) vs enrolled A: ${score.toFixed(3)}`)
  })
}

// Speaker clustering experiments on the real-voice sessions (sessions.cjs), without Whisper: speech
// regions come from the reference (oracle speech detection, as diarization papers report
// clustering) or, with --regions diarizer, from the pyannote segmentation the app runs, whose
// segments also end at speaker changes. Each region is cut into sliding windows, every window is embedded once per
// model, and then each clustering method labels the windows. Frames take the majority label of
// the windows over them; DER and the speaker count are scored against the reference.
//
//   LYRA_MODELS_DIR=<dir> node scripts/eval/cluster-lab.cjs [--embedding a.onnx,b.onnx]
//     [--windows 1.5,3] [--bars 0.2,0.3] [--regions oracle|diarizer] [--scenarios a,b] [--seeds 3]
//     [--min-window 1]    cluster only windows this long; shorter ones take the nearest speaker
//     [--min-speaker 2]   fold speakers with less speech than this into the closest
//     [--merge-centroids 0.6]   then merge speakers whose mean voiceprints are at least this alike
//
// Methods:
// - ahc@t: average-linkage agglomerative clustering on cosine similarity, stopping below t.
// - sc: spectral clustering that picks its own speaker count (NME-SC, Park et al., "Auto-Tuning
//   Spectral Clustering for Speaker Diarization Using Normalized Maximum Eigengap", 2019).
// Speakers with under 2 s of windows are folded into the most similar remaining speaker.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const sherpa = require('sherpa-onnx-node')
const { random } = require('./acoustics.cjs')
const { der } = require('./metrics.cjs')
const { DEFAULT_SESSIONS, sessionDir, sessionIds } = require('./sessions.cjs')
const { RATE, readWav } = require('./wav.cjs')

const root = join(__dirname, '..', '..')
let MIN_SPEAKER_SECONDS = 2
/** Windows shorter than this are left out of clustering and take the nearest speaker after. */
let MIN_WINDOW_SECONDS = 0

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function unit(vector) {
  let length = 0
  for (const value of vector) length += value * value
  length = Math.sqrt(length) || 1
  return vector.map((value) => value / length)
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)

/** Speech regions: reference turns merged where they touch or overlap. */
function regions(reference) {
  const sorted = [...reference.segments].sort((a, b) => a.start - b.start)
  const out = []
  for (const { start, end } of sorted) {
    const last = out.at(-1)
    if (last && start <= last.end + 0.05) last.end = Math.max(last.end, end)
    else out.push({ start, end })
  }
  return out
}

/** The segments of the app's diarizer (pyannote segmentation, as the speaker worker runs it), labels ignored. */
function segmented(models, audio, file) {
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: join(models, 'pyannote-segmentation-3.0.onnx') }, numThreads: 4 },
    embedding: { model: join(models, file), numThreads: 4 },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  return diarizer.process(audio).map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start)
}

/** Windows of `size` seconds with half-window hops over each region; short regions are one window. */
function windows(spans, size) {
  const out = []
  for (const { start, end } of spans) {
    if (end - start <= size * 1.5) {
      out.push({ start, end })
      continue
    }
    for (let at = start; at < end - size / 2; at += size / 2) out.push({ start: at, end: Math.min(end, at + size) })
  }
  return out
}

function embedAll(extractor, audio, spans) {
  return spans.map(({ start, end }) => {
    const stream = extractor.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: audio.subarray(Math.floor(start * RATE), Math.floor(end * RATE)) })
    stream.inputFinished()
    return unit(Array.from(extractor.compute(stream, false)))
  })
}

/** Average-linkage AHC: merge the most similar pair while its similarity is at least `bar`. */
function ahc(embeddings, bar) {
  const n = embeddings.length
  const sim = embeddings.map((a) => embeddings.map((b) => dot(a, b)))
  let clusters = embeddings.map((_, i) => ({ members: [i] }))
  const link = (a, b) => {
    let total = 0
    for (const i of a.members) for (const j of b.members) total += sim[i][j]
    return total / (a.members.length * b.members.length)
  }
  // Cache pairwise links; update only rows touching the merged cluster.
  let links = clusters.map((a, i) => clusters.map((b, j) => (i < j ? link(a, b) : -Infinity)))
  for (;;) {
    let best = { score: -Infinity, i: -1, j: -1 }
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) if (links[i][j] > best.score) best = { score: links[i][j], i, j }
    }
    if (best.score < bar || clusters.length === 1) break
    const merged = { members: [...clusters[best.i].members, ...clusters[best.j].members] }
    clusters = clusters.filter((_, k) => k !== best.i && k !== best.j)
    links = links.filter((_, k) => k !== best.i && k !== best.j).map((row) => row.filter((_, k) => k !== best.i && k !== best.j))
    clusters.push(merged)
    const row = clusters.map((c, k) => (k < clusters.length - 1 ? link(c, merged) : -Infinity))
    links.forEach((r, k) => r.push(row[k]))
    links.push(clusters.map(() => -Infinity))
  }
  const labels = new Array(n)
  clusters.forEach((cluster, label) => cluster.members.forEach((i) => (labels[i] = label)))
  return labels
}

/** Eigenvalues (ascending) and eigenvectors (columns) of a symmetric matrix, by cyclic Jacobi. */
function eigen(matrix) {
  const n = matrix.length
  const a = matrix.map((row) => Float64Array.from(row))
  const v = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]
    if (off < 1e-10) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-12) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j])
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => v.map((row) => row[i])) }
}

function kmeans(points, k, rand) {
  const centers = [points[Math.floor(rand() * points.length)]]
  while (centers.length < k) {
    const d = points.map((p) => Math.min(...centers.map((c) => p.reduce((s, x, i) => s + (x - c[i]) ** 2, 0))))
    let pick = rand() * d.reduce((s, x) => s + x, 0)
    centers.push(points[Math.max(0, d.findIndex((x) => (pick -= x) <= 0))])
  }
  let labels = []
  for (let round = 0; round < 50; round++) {
    const next = points.map((p) => {
      let best = 0
      let bestD = Infinity
      centers.forEach((c, j) => {
        const dist = p.reduce((s, x, i) => s + (x - c[i]) ** 2, 0)
        if (dist < bestD) [best, bestD] = [j, dist]
      })
      return best
    })
    if (next.every((label, i) => label === labels[i])) break
    labels = next
    for (let j = 0; j < k; j++) {
      const own = points.filter((_, i) => labels[i] === j)
      if (own.length) centers[j] = own[0].map((_, d) => own.reduce((s, p) => s + p[d], 0) / own.length)
    }
  }
  return labels
}

/** NME-SC: prune the affinity to each row's top-p neighbours, pick p and k by normalized eigengap. */
function spectral(embeddings, maxSpeakers = 8) {
  const n = embeddings.length
  if (n < 4) return embeddings.map(() => 0)
  // The Jacobi eigen-solver is cubic; past a few hundred windows it takes minutes.
  if (n > 300) return embeddings.map((_, i) => -1 - i)
  const sim = embeddings.map((a) => embeddings.map((b) => dot(a, b)))
  let best = null
  for (const ratio of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
    const p = Math.max(2, Math.floor(n * ratio))
    const pruned = sim.map((row) => {
      const keep = new Set(row.map((value, j) => [value, j]).sort((x, y) => y[0] - x[0]).slice(0, p).map(([, j]) => j))
      return row.map((value, j) => (keep.has(j) ? 1 : 0))
    })
    const affinity = pruned.map((row, i) => row.map((value, j) => (value + pruned[j][i]) / 2))
    const degree = affinity.map((row) => row.reduce((s, x) => s + x, 0))
    const laplacian = affinity.map((row, i) => row.map((value, j) => (i === j ? degree[i] - value : -value)))
    const { values, vectors } = eigen(laplacian)
    const top = Math.min(maxSpeakers, n - 1)
    let gap = { size: -Infinity, k: 1 }
    for (let k = 1; k <= top; k++) {
      const size = values[k] - values[k - 1]
      if (size > gap.size) gap = { size, k }
    }
    const score = p / n / (gap.size / Math.max(1e-9, values[top]))
    if (!best || score < best.score) best = { score, k: gap.k, vectors }
  }
  if (best.k === 1) return embeddings.map(() => 0)
  const points = embeddings.map((_, i) => best.vectors.slice(0, best.k).map((vector) => vector[i]))
  return kmeans(points, best.k, random(n))
}

/** Clusters the windows of at least MIN_WINDOW_SECONDS; shorter ones join the nearest centroid. */
function clusterLong(method, spans, embeddings) {
  const keep = spans.map((span) => span.end - span.start >= MIN_WINDOW_SECONDS)
  if (keep.filter(Boolean).length < 2) return method(embeddings)
  const long = embeddings.filter((_, i) => keep[i])
  const labels = method(long)
  const centres = new Map()
  long.forEach((e, i) => {
    const sum = centres.get(labels[i]) ?? e.map(() => 0)
    centres.set(labels[i], sum.map((v, d) => v + e[d]))
  })
  let k = 0
  return embeddings.map((e, i) => {
    if (keep[i]) return labels[k++]
    let best = null
    for (const [label, c] of centres) if (!best || dot(e, unit(c)) > best.score) best = { label, score: dot(e, unit(c)) }
    return best.label
  })
}

let MERGE_CENTROIDS = 0
/** Merges the closest pair of speakers while their mean voiceprints are at least MERGE_CENTROIDS alike. */
function mergeCentroids(labels, embeddings) {
  if (!MERGE_CENTROIDS) return labels
  let out = [...labels]
  for (;;) {
    const ids = [...new Set(out)]
    const cent = new Map(ids.map((id) => [id, unit(embeddings[0].map((_, d) => out.reduce((t, l, i) => (l === id ? t + embeddings[i][d] : t), 0)))]))
    let best = null
    for (const a of ids) for (const b of ids) if (a < b) {
      const score = dot(cent.get(a), cent.get(b))
      if (score >= MERGE_CENTROIDS && (!best || score > best.score)) best = { a, b, score }
    }
    if (!best) return out
    out = out.map((l) => (l === best.b ? best.a : l))
  }
}

/** Folds speakers with under MIN_SPEAKER_SECONDS of windows into the most similar other speaker. */
function foldTiny(labels, spans, embeddings) {
  const talk = new Map()
  labels.forEach((label, i) => talk.set(label, (talk.get(label) ?? 0) + spans[i].end - spans[i].start))
  const real = [...talk].filter(([, seconds]) => seconds >= MIN_SPEAKER_SECONDS).map(([label]) => label)
  if (!real.length) return labels
  const centroid = (label) => unit(embeddings[0].map((_, d) => labels.reduce((s, l, i) => (l === label ? s + embeddings[i][d] : s), 0)))
  const centroids = new Map(real.map((label) => [label, centroid(label)]))
  return labels.map((label, i) => {
    if (centroids.has(label)) return label
    return real.reduce((best, other) => (dot(embeddings[i], centroids.get(other)) > dot(embeddings[i], centroids.get(best)) ? other : best))
  })
}

/** Frame labels by majority of covering windows, back to segments. */
function toSegments(spans, labels) {
  const step = 0.05
  const end = Math.max(...spans.map((s) => s.end))
  const out = []
  for (let t = 0; t < end; t += step) {
    const votes = new Map()
    spans.forEach((span, i) => {
      if (span.start <= t && t < span.end) votes.set(labels[i], (votes.get(labels[i]) ?? 0) + 1)
    })
    if (!votes.size) continue
    const speaker = [...votes].sort((a, b) => b[1] - a[1])[0][0]
    const last = out.at(-1)
    if (last && last.speaker === speaker && Math.abs(last.end - t) < step / 2) last.end = t + step
    else out.push({ speaker, start: t, end: t + step })
  }
  return out
}

function main() {
  const models = process.env.LYRA_MODELS_DIR
  if (!models) throw new Error('set LYRA_MODELS_DIR to the folder with the speaker models')
  const dataDir = process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data')
  const names = sessionIds(arg('scenarios', DEFAULT_SESSIONS.join(',')).split(','), Number(arg('seeds', '1')))
  const sizes = arg('windows', '1.5,3').split(',').map(Number)
  MIN_WINDOW_SECONDS = Number(arg('min-window', '0'))
  MIN_SPEAKER_SECONDS = Number(arg('min-speaker', '2'))
  MERGE_CENTROIDS = Number(arg('merge-centroids', '0'))
  const bars = arg('bars', '0.3,0.4,0.5,0.6,0.7').split(',').map(Number)
  const methods = [...bars.map((bar) => ({ name: `ahc@${bar}`, run: (e) => ahc(e, bar) })), { name: 'sc', run: (e) => spectral(e) }]
  for (const file of arg('embedding', 'wespeaker-en-voxceleb-resnet34-LM.onnx').split(',')) {
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: join(models, file), numThreads: 8 })
    for (const size of sizes) {
      process.stdout.write(`== ${file}, ${size} s windows\n${'session'.padEnd(18)}${methods.map((m) => m.name.padStart(14)).join('')}\n`)
      const totals = methods.map(() => ({ error: 0, time: 0, right: 0 }))
      for (const name of names) {
        const dir = sessionDir(dataDir, name)
        if (!existsSync(join(dir, 'reference.json'))) continue
        const reference = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'))
        const mic = readWav(join(dir, 'mic.wav'))
        const system = readWav(join(dir, 'system.wav'))
        const audio = mic.map((value, i) => Math.max(-1, Math.min(1, value + (system[i] ?? 0))))
        const spans = windows(arg('regions', 'oracle') === 'diarizer' ? segmented(models, audio, file) : regions(reference), size)
        const embeddings = embedAll(extractor, audio, spans)
        const refSpeakers = reference.speakers.length
        let row = name.padEnd(18)
        methods.forEach((method, m) => {
          const labels = mergeCentroids(foldTiny(clusterLong(method.run, spans, embeddings), spans, embeddings), embeddings)
          const result = der(reference, { segments: toSegments(spans, labels) })
          const found = new Set(labels).size
          totals[m].error += result.rate * result.scoredSeconds
          totals[m].time += result.scoredSeconds
          if (found === refSpeakers) totals[m].right++
          row += `${(result.rate * 100).toFixed(1).padStart(8)}% ${found}/${refSpeakers}`
        })
        process.stdout.write(`${row}\n`)
      }
      process.stdout.write(
        `${'overall DER'.padEnd(18)}${totals.map((t) => `${((t.error / Math.max(1, t.time)) * 100).toFixed(1).padStart(8)}% ${String(t.right).padStart(2)}ok`).join('')}\n\n`
      )
    }
  }
}

main()

// Scoring for meeting evals: WER, cpWER (speaker-attributed WER) and DER.
//
// Both sides use one shape: { segments: [{ speaker, start, end, text }] }, times in seconds.
// These are dependency-free approximations of the standard tools (meeteval for cpWER,
// md-eval / pyannote.metrics for DER). They're good for tracking Lyra against itself, but
// use those tools for numbers you compare with published results.

/** Fillers that one side writes and the other drops; they'd dominate errors without telling us much. */
const FILLERS = new Set(['um', 'uh', 'uhm', 'hmm', 'hm', 'mm', 'mmm', 'mm-hmm', 'uh-huh', 'ah', 'eh', 'er', 'erm'])

/** Lowercases, drops punctuation and fillers, and splits into words. */
function normalize(text) {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLERS.has(word))
  // Split hyphenated words after the filler check, so "mm-hmm" is a filler but "e-mail" is two words.
  return words.flatMap((word) => word.split('-')).map((word) => word.replace(/^'+|'+$/g, '')).filter(Boolean)
}

/** Word-level Levenshtein distance, in two rows so hour-long meetings fit in memory. */
function editDistance(ref, hyp) {
  if (ref.length === 0) return hyp.length
  if (hyp.length === 0) return ref.length
  let prev = new Int32Array(hyp.length + 1)
  let next = new Int32Array(hyp.length + 1)
  for (let j = 0; j <= hyp.length; j++) prev[j] = j
  for (let i = 1; i <= ref.length; i++) {
    next[0] = i
    const word = ref[i - 1]
    for (let j = 1; j <= hyp.length; j++) {
      const sub = prev[j - 1] + (word === hyp[j - 1] ? 0 : 1)
      next[j] = Math.min(sub, prev[j] + 1, next[j - 1] + 1)
    }
    ;[prev, next] = [next, prev]
  }
  return prev[hyp.length]
}

/**
 * Minimum-cost assignment of rows to columns (Hungarian algorithm) on a square matrix.
 * Returns `assignment[row] = column`.
 */
function hungarian(cost) {
  const n = cost.length
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Infinity)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const assignment = new Array(n)
  for (let j = 1; j <= n; j++) assignment[p[j] - 1] = j - 1
  return assignment
}

/** Pads a rows × cols matrix to square with `fill(row, col)` for the dummy cells. */
function square(matrix, rows, cols, fill) {
  const n = Math.max(rows, cols)
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i < rows && j < cols ? matrix[i][j] : fill(i, j)))
  )
}

const byStart = (a, b) => a.start - b.start
const speakersOf = (segments) => [...new Set(segments.map((segment) => segment.speaker))]
const wordsOf = (segments) => segments.slice().sort(byStart).flatMap((segment) => normalize(segment.text))

/** Plain WER over the whole meeting, ignoring who spoke. */
function wer(ref, hyp) {
  const refWords = wordsOf(ref.segments)
  const errors = editDistance(refWords, wordsOf(hyp.segments))
  return { errors, words: refWords.length, rate: refWords.length ? errors / refWords.length : 0 }
}

/**
 * Concatenated minimum-permutation WER: each speaker's words are joined in time order, and
 * reference speakers are matched to hypothesis speakers to minimize total errors. Words given
 * to the wrong speaker count as errors, so this measures transcription and attribution together.
 */
function cpWer(ref, hyp) {
  const refSpeakers = speakersOf(ref.segments)
  const hypSpeakers = speakersOf(hyp.segments)
  const refWords = refSpeakers.map((s) => wordsOf(ref.segments.filter((seg) => seg.speaker === s)))
  const hypWords = hypSpeakers.map((s) => wordsOf(hyp.segments.filter((seg) => seg.speaker === s)))
  const matrix = refWords.map((r) => hypWords.map((h) => editDistance(r, h)))
  // An unmatched speaker's words are all errors: deletions on the ref side, insertions on the hyp side.
  const cost = square(matrix, refWords.length, hypWords.length, (i, j) =>
    i < refWords.length ? refWords[i].length : j < hypWords.length ? hypWords[j].length : 0
  )
  const assignment = hungarian(cost)
  const errors = assignment.reduce((sum, j, i) => sum + cost[i][j], 0)
  const words = refWords.reduce((sum, w) => sum + w.length, 0)
  const mapping = {}
  assignment.forEach((j, i) => {
    if (i < refSpeakers.length && j < hypSpeakers.length) mapping[refSpeakers[i]] = hypSpeakers[j]
  })
  return { errors, words, rate: words ? errors / words : 0, mapping }
}

const FRAME = 0.01

/** Per-frame sets of active speaker indexes. */
function frames(segments, speakers, length) {
  const out = Array.from({ length }, () => [])
  for (const segment of segments) {
    const index = speakers.indexOf(segment.speaker)
    const from = Math.max(0, Math.round(segment.start / FRAME))
    const to = Math.min(length, Math.round(segment.end / FRAME))
    for (let f = from; f < to; f++) if (!out[f].includes(index)) out[f].push(index)
  }
  return out
}

/**
 * Diarization error rate: missed speech + false alarm + speaker confusion, over total reference
 * speaker time. Overlapped speech is scored. Frames within `collar` seconds of a reference
 * boundary are skipped, as md-eval does, since boundaries are fuzzy in any annotation.
 */
function der(ref, hyp, { collar = 0.25 } = {}) {
  const end = Math.max(0, ...ref.segments.map((s) => s.end), ...hyp.segments.map((s) => s.end))
  const length = Math.ceil(end / FRAME) + 1
  const refSpeakers = speakersOf(ref.segments)
  const hypSpeakers = speakersOf(hyp.segments)
  const refFrames = frames(ref.segments, refSpeakers, length)
  const hypFrames = frames(hyp.segments, hypSpeakers, length)

  const skip = new Uint8Array(length)
  const pad = Math.round(collar / FRAME)
  for (const segment of ref.segments) {
    for (const edge of [segment.start, segment.end]) {
      const at = Math.round(edge / FRAME)
      for (let f = Math.max(0, at - pad); f < Math.min(length, at + pad); f++) skip[f] = 1
    }
  }

  // Map speakers to maximize overlapping time, then count errors under that mapping.
  const overlap = refSpeakers.map(() => new Array(hypSpeakers.length).fill(0))
  for (let f = 0; f < length; f++) {
    if (skip[f]) continue
    for (const r of refFrames[f]) for (const h of hypFrames[f]) overlap[r][h] += 1
  }
  const most = Math.max(0, ...overlap.flat())
  const cost = square(
    overlap.map((row) => row.map((value) => most - value)),
    refSpeakers.length,
    hypSpeakers.length,
    () => most
  )
  const assignment = hungarian(cost)
  const mapped = new Map()
  assignment.forEach((j, i) => {
    if (i < refSpeakers.length && j < hypSpeakers.length) mapped.set(i, j)
  })

  let total = 0
  let missed = 0
  let falseAlarm = 0
  let confusion = 0
  for (let f = 0; f < length; f++) {
    if (skip[f]) continue
    const r = refFrames[f]
    const h = hypFrames[f]
    const correct = r.filter((index) => mapped.has(index) && h.includes(mapped.get(index))).length
    total += r.length
    missed += Math.max(0, r.length - h.length)
    falseAlarm += Math.max(0, h.length - r.length)
    confusion += Math.min(r.length, h.length) - correct
  }
  const seconds = (frameCount) => +(frameCount * FRAME).toFixed(2)
  return {
    rate: total ? (missed + falseAlarm + confusion) / total : 0,
    missed: total ? missed / total : 0,
    falseAlarm: total ? falseAlarm / total : 0,
    confusion: total ? confusion / total : 0,
    scoredSeconds: seconds(total)
  }
}

/** All metrics for one meeting. */
function score(ref, hyp) {
  return {
    refSpeakers: speakersOf(ref.segments).length,
    hypSpeakers: speakersOf(hyp.segments).length,
    wer: wer(ref, hyp),
    cpWer: cpWer(ref, hyp),
    der: der(ref, hyp)
  }
}

module.exports = { normalize, editDistance, hungarian, wer, cpWer, der, score }

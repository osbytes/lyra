/**
 * Who spoke when, from voiceprints of short windows: the clustering half of diarization.
 *
 * The segmentation model finds speech and the points where the voice changes; each of its
 * segments is cut into windows a few seconds long, every window gets a voiceprint, and windows
 * are grouped by average-linkage clustering on cosine similarity. On real voices at one desk mic
 * this beat sherpa-onnx's own clustering by a wide margin (scripts/eval/cluster-lab.cjs), mostly
 * because a window of a few seconds gives a steadier voiceprint than the diarizer's short pieces.
 *
 * Pure functions, so the worker and the eval scripts run the same code.
 */

export type Span = { start: number; end: number }

/** Windows of `size` seconds, half-overlapping, inside each segment; a short segment is one window. */
export function speechWindows(segments: readonly Span[], size: number): Span[] {
  const out: Span[] = []
  for (const { start, end } of segments) {
    if (end - start <= size * 1.5) {
      out.push({ start, end })
      continue
    }
    for (let at = start; at < end - size / 2; at += size / 2) {
      out.push({ start: at, end: Math.min(end, at + size) })
    }
  }
  return out
}

export function unit(vector: readonly number[]): number[] {
  let length = 0
  for (const value of vector) length += value * value
  length = Math.sqrt(length) || 1
  return vector.map((value) => value / length)
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/**
 * Average-linkage clustering of unit vectors, cut where linkage similarity falls below `bar`.
 * Uses the nearest-neighbour chain, O(n²) time and memory: average linkage is reducible, so
 * its merges form the same tree as the greedy algorithm, and keeping the merges at or above
 * `bar` gives the same clusters. Returns a label per vector, numbered 0… by first appearance.
 */
export function averageLinkage(vectors: readonly (readonly number[])[], bar: number): number[] {
  const n = vectors.length
  if (n === 0) return []
  const sim = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    const a = vectors[i] ?? []
    for (let j = i + 1; j < n; j++) {
      const value = dot(a, vectors[j] ?? [])
      sim[i * n + j] = value
      sim[j * n + i] = value
    }
  }
  const size = new Int32Array(n).fill(1)
  const active = new Uint8Array(n).fill(1)
  const merges: { a: number; b: number; score: number }[] = []
  const chain: number[] = []
  let remaining = n
  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(1))
    const top = chain.at(-1) ?? 0
    const previous = chain.length > 1 ? (chain.at(-2) ?? -1) : -1
    // The most similar active cluster to `top`; ties go to the previous link so the chain ends.
    let best = previous
    let bestScore = previous === -1 ? -Infinity : (sim[top * n + previous] ?? -Infinity)
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === top) continue
      const score = sim[top * n + k] ?? -Infinity
      if (score > bestScore) {
        best = k
        bestScore = score
      }
    }
    if (best !== previous) {
      chain.push(best)
      continue
    }
    // `top` and `previous` are each other's nearest: merge them into `previous`.
    chain.pop()
    chain.pop()
    merges.push({ a: previous, b: top, score: bestScore })
    const sa = size[previous] ?? 1
    const sb = size[top] ?? 1
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === previous || k === top) continue
      const value = ((sim[previous * n + k] ?? 0) * sa + (sim[top * n + k] ?? 0) * sb) / (sa + sb)
      sim[previous * n + k] = value
      sim[k * n + previous] = value
    }
    size[previous] = sa + sb
    active[top] = 0
    remaining--
  }
  // Union the merges at or above the bar; their indices are the clusters' representatives.
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    let root = i
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root
    return root
  }
  for (const { a, b, score } of merges) if (score >= bar) parent[find(b)] = find(a)
  const labels = new Map<number, number>()
  return Array.from({ length: n }, (_, i) => {
    const root = find(i)
    const label = labels.get(root) ?? labels.size
    labels.set(root, label)
    return label
  })
}

/**
 * Clusters the windows of at least `minWindow` seconds; shorter ones (the end of a segment, a
 * one-word reply) carry a noisy voiceprint that would start speakers of its own, so they take
 * the nearest cluster afterwards instead.
 */
export function clusterLongWindows(
  spans: readonly Span[],
  vectors: readonly (readonly number[])[],
  bar: number,
  minWindow: number
): number[] {
  const long = spans.map((span) => span.end - span.start >= minWindow)
  const kept = vectors.filter((_, i) => long[i])
  if (kept.length < 2) return averageLinkage(vectors, bar)
  const keptLabels = averageLinkage(kept, bar)
  const centres = centroids(keptLabels, kept)
  let next = 0
  return vectors.map((vector, i) => {
    if (long[i]) return keptLabels[next++] ?? 0
    let best = 0
    let bestScore = -Infinity
    for (const [label, centre] of centres) {
      const score = dot(vector, centre)
      if (score > bestScore) {
        best = label
        bestScore = score
      }
    }
    return best
  })
}

/** The mean direction of each label's vectors. */
export function centroids(labels: readonly number[], vectors: readonly (readonly number[])[]): Map<number, number[]> {
  const sums = new Map<number, number[]>()
  labels.forEach((label, i) => {
    const vector = vectors[i] ?? []
    const sum = sums.get(label) ?? new Array<number>(vector.length).fill(0)
    vector.forEach((value, d) => (sum[d] = (sum[d] ?? 0) + value))
    sums.set(label, sum)
  })
  return new Map([...sums].map(([label, sum]) => [label, unit(sum)]))
}

/**
 * Moves the windows of speakers with under `minSeconds` of speech to the most similar speaker
 * that has enough: a few windows of their own are usually one person's cough, laugh or a
 * stretch of crosstalk, not another person.
 */
export function foldShortSpeakers(
  labels: readonly number[],
  spans: readonly Span[],
  vectors: readonly (readonly number[])[],
  minSeconds: number
): number[] {
  const talk = new Map<number, number>()
  labels.forEach((label, i) => {
    const span = spans[i]
    if (span) talk.set(label, (talk.get(label) ?? 0) + span.end - span.start)
  })
  const kept = [...talk].filter(([, seconds]) => seconds >= minSeconds).map(([label]) => label)
  if (kept.length === 0) return [...labels]
  const centres = centroids(labels, vectors)
  return labels.map((label, i) => {
    if (kept.includes(label)) return label
    const vector = vectors[i] ?? []
    let best = kept[0] ?? label
    let bestScore = -Infinity
    for (const other of kept) {
      const score = dot(vector, centres.get(other) ?? [])
      if (score > bestScore) {
        best = other
        bestScore = score
      }
    }
    return best
  })
}

/**
 * Back from windows to time: each `step` of audio takes the label most of its windows have,
 * and runs of one label become a segment. Windows overlap, so this smooths single odd windows.
 */
export function labelTimeline(
  spans: readonly Span[],
  labels: readonly number[],
  step = 0.05
): (Span & { speaker: number })[] {
  const out: (Span & { speaker: number })[] = []
  const order = spans.map((span, i) => ({ span, label: labels[i] ?? 0 })).sort((a, b) => a.span.start - b.span.start)
  const end = Math.max(0, ...spans.map((span) => span.end))
  let from = 0
  for (let t = 0; t < end; t += step) {
    while (from < order.length && (order[from]?.span.end ?? 0) <= t) from++
    const votes = new Map<number, number>()
    for (let k = from; k < order.length; k++) {
      const entry = order[k]
      if (!entry || entry.span.start > t) break
      if (entry.span.end > t) votes.set(entry.label, (votes.get(entry.label) ?? 0) + 1)
    }
    let speaker = -1
    let most = 0
    for (const [label, count] of votes) {
      if (count > most) {
        speaker = label
        most = count
      }
    }
    if (speaker === -1) continue
    const last = out.at(-1)
    if (last?.speaker === speaker && Math.abs(last.end - t) < step / 2) last.end = t + step
    else out.push({ start: t, end: t + step, speaker })
  }
  return out
}

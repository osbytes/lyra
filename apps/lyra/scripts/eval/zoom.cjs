// Reference speaker turns read off a recorded Zoom meeting's video: in gallery view Zoom draws a
// green border around whoever it hears, and each tile carries the person's name. Public meeting
// recordings (GitLab streams many to YouTube) become real video calls with labels, without
// anyone labelling them by hand.
//
// What this reference can't see: Zoom outlines one person at a time, so overlapped speech
// counts for one of them; the border follows Zoom's own speaker detection, which runs a little
// late (estimated per video and taken off); and it stays on the last person through a pause,
// so turns are cut to where the audio has speech. Stretches with no border (screen share,
// speaker view) are left out of the audio and the reference both. Good for DER at the usual
// collar, not for sub-second boundaries.
//
// Pure functions here; `zoom-video.cjs` downloads, decodes and reads names.

const { editDistance } = require('./metrics.cjs')

/**
 * Zoom's active-speaker border: a saturated green, about rgb(100, 244, 0), darker at the edges
 * of a thin border once the video is compressed (rgb(38, 163, 0) on small tiles).
 */
function isBorderGreen(r, g, b) {
  return g > 140 && g - r > 70 && g - b > 100
}

/** A border edge is at least this long, in pixels; smaller tiles than this are not read. */
const MIN_EDGE = 40

/**
 * The highlighted tile in one RGB24 frame, as its border's outer box, or null. Looks for two
 * long green rows with the same ends and checks the sides between them, so a green shirt or
 * background on screen isn't taken for the border.
 */
function findHighlight(frame, width, height) {
  const green = (x, y) => {
    const i = (y * width + x) * 3
    return isBorderGreen(frame[i], frame[i + 1], frame[i + 2])
  }
  /** Each row's longest green run, bridging gaps of up to two pixels (compression). */
  const runs = []
  for (let y = 0; y < height; y++) {
    let best = null
    let start = -1
    let lastGreen = -1
    for (let x = 0; x <= width; x++) {
      if (x < width && green(x, y)) {
        if (start < 0 || x - lastGreen > 3) start = x
        lastGreen = x
      } else if (start >= 0 && (x === width || x - lastGreen > 3)) {
        if (!best || lastGreen - start > best.x1 - best.x0) best = { x0: start, x1: lastGreen }
        start = -1
      }
    }
    runs.push(best && best.x1 - best.x0 + 1 >= MIN_EDGE ? best : null)
  }
  const near = (a, b) => Math.abs(a - b) <= 4
  for (let top = 0; top < height; top++) {
    const edge = runs[top]
    if (!edge) continue
    let bottom = -1
    for (let y = height - 1; y >= top + MIN_EDGE; y--) {
      const run = runs[y]
      if (run && near(run.x0, edge.x0) && near(run.x1, edge.x1)) {
        bottom = y
        break
      }
    }
    if (bottom < 0) continue
    /** The share of rows with green within two pixels inside the edge at `x`. */
    const side = (x, inward) => {
      let count = 0
      for (let y = top; y <= bottom; y++) if ([0, 1, 2].some((d) => green(x + d * inward, y))) count++
      return count / (bottom - top + 1)
    }
    if (side(edge.x0, 1) > 0.8 && side(edge.x1, -1) > 0.8) return { x0: edge.x0, y0: top, x1: edge.x1, y1: bottom }
  }
  return null
}

const sameBox = (a, b) =>
  a === b || (a !== null && b !== null && ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(a[k] - b[k]) <= 3))

/**
 * Runs of frames with the same highlighted box: [{ start, end, box }] in seconds, where `box`
 * is null while nothing is highlighted. A box seen for a single frame is taken as the frame
 * before it (a fade between tiles).
 */
function highlightRuns(boxes, fps) {
  const runs = []
  for (let i = 0; i < boxes.length; i++) {
    let box = boxes[i]
    if (i > 0 && i + 1 < boxes.length && !sameBox(box, boxes[i - 1]) && !sameBox(box, boxes[i + 1])) box = boxes[i - 1]
    const last = runs[runs.length - 1]
    if (last && sameBox(last.box, box)) last.end = (i + 1) / fps
    else runs.push({ start: i / fps, end: (i + 1) / fps, box })
  }
  return runs
}

/**
 * Where the audio has speech: 30 ms frames louder than the quiet floor (its 10th percentile)
 * by `margin` dB, joined across gaps shorter than `bridge` seconds, dropping blips shorter
 * than `shortest`. Rough on purpose: it only trims the border's hold through pauses.
 */
function speechRegions(samples, rate, { margin = 12, bridge = 0.3, shortest = 0.2 } = {}) {
  const hop = Math.round(rate * 0.03)
  const levels = []
  for (let at = 0; at + hop <= samples.length; at += hop) {
    let sum = 0
    for (let i = at; i < at + hop; i++) sum += samples[i] * samples[i]
    levels.push(10 * Math.log10(sum / hop + 1e-10))
  }
  if (levels.length === 0) return []
  const floor = levels.slice().sort((a, b) => a - b)[Math.floor(levels.length * 0.1)]
  const regions = []
  levels.forEach((level, index) => {
    if (level < floor + margin) return
    const start = (index * hop) / rate
    const end = ((index + 1) * hop) / rate
    const last = regions[regions.length - 1]
    if (last && start - last.end < bridge) last.end = end
    else regions.push({ start, end })
  })
  return regions.filter((r) => r.end - r.start >= shortest)
}

/**
 * How late the border is, in seconds: the shift that puts the most changes of highlighted tile
 * within `window` of the start of a speech region, and of those, the one that puts them
 * closest. Searched over 0 to `most`.
 */
function estimateLag(runs, speech, { most = 2, step = 0.05, window = 0.25 } = {}) {
  const changes = []
  for (let i = 1; i < runs.length; i++) if (runs[i].box && runs[i - 1].box) changes.push(runs[i].start)
  const onsets = speech.map((r) => r.start)
  let best = { lag: 0, hits: -1, distance: Infinity }
  for (let lag = 0; lag <= most + 1e-9; lag += step) {
    let hits = 0
    let distance = 0
    for (const change of changes) {
      const nearest = Math.min(...onsets.map((onset) => Math.abs(change - lag - onset)))
      if (nearest <= window) {
        hits++
        distance += nearest
      }
    }
    if (hits > best.hits || (hits === best.hits && distance < best.distance - 1e-9)) best = { lag: +lag.toFixed(2), hits, distance }
  }
  return { lag: best.lag, changes: changes.length, matched: Math.max(0, best.hits) }
}

/**
 * Reference turns: each run's speaker (`nameOf(run)`, null when unknown), moved earlier by
 * `lag`, cut to the speech regions. Runs with no box or no name are not scored.
 */
function turns(runs, speech, nameOf, lag) {
  const out = []
  for (const run of runs) {
    const speaker = run.box ? nameOf(run) : null
    if (!speaker) continue
    const start = Math.max(0, run.start - lag)
    const end = Math.max(0, run.end - lag)
    for (const region of speech) {
      const from = Math.max(start, region.start)
      const to = Math.min(end, region.end)
      if (to - from > 0.05) out.push({ speaker, start: from, end: to, text: '' })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The stretches to keep: spans of runs with a highlight, ignoring gaps of no highlight shorter
 * than `gap` seconds (a tile fading or the layout reflowing), at least `shortest` long.
 */
function scoredSpans(runs, { gap = 3, shortest = 30 } = {}) {
  const spans = []
  for (const run of runs) {
    if (!run.box) continue
    const last = spans[spans.length - 1]
    if (last && run.start - last.end <= gap) last.end = run.end
    else spans.push({ start: run.start, end: run.end })
  }
  return spans.filter((s) => s.end - s.start >= shortest)
}

/** Moves turns inside `spans` onto a timeline where only the spans are kept, back to back. */
function onKeptTimeline(segments, spans) {
  const out = []
  let offset = 0
  for (const span of spans) {
    for (const s of segments) {
      const from = Math.max(s.start, span.start)
      const to = Math.min(s.end, span.end)
      if (to > from) out.push({ ...s, start: +(from - span.start + offset).toFixed(3), end: +(to - span.start + offset).toFixed(3) })
    }
    offset += span.end - span.start
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * A tile's name as OCR read it, cleaned: the part before the title Zoom shows after it ("Ada
 * Lovelace - CTO"; OCR reads the dash as any of these marks) or the "..." of a cut-off name.
 */
function cleanName(text) {
  const name = text
    .replace(/^[^A-Za-z]+|^I\s+(?=[A-Z])/g, '')
    .split(/\s*[-–—•|:;,·¯]+\s|\s[-–—•|:;,·¯]+|[-–—•|:;,·¯]|\.{2,}|…/)[0]
    .replace(/[^A-Za-z]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length >= 2 ? name : null
}

/**
 * One spelling per person: names read a few characters apart (OCR on small tiles) or cut short
 * on a narrower tile ("Christopher Le", "Christo") are the same person, under the longest
 * spelling read at least twice (or the longest, when none was).
 */
function canonicalNames(readings) {
  const counts = new Map()
  for (const name of readings) counts.set(name, (counts.get(name) ?? 0) + 1)
  const key = (name) => name.toLowerCase().replace(/[^a-z]/g, '')
  const words = (name) => name.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const same = (nameA, nameB) => {
    const [a, b] = [key(nameA), key(nameB)]
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (short.length >= 3 && long.startsWith(short)) return true
    if (editDistance(a, b) <= Math.max(1, Math.floor(short.length * 0.25))) return true
    // A cut-off name with a misread letter: compare it with as much of the longer one.
    if (short.length >= 6 && editDistance(short, long.slice(0, short.length)) <= 1) return true
    // A short first name misread ("Lily Mai" as "uy Mai"): the same last name, a close first.
    const [wa, wb] = [words(nameA), words(nameB)]
    return (
      wa.length >= 2 && wb.length >= 2 && wa.at(-1).length >= 3 && wa.at(-1) === wb.at(-1) && editDistance(wa[0], wb[0]) <= 2
    )
  }
  /** Longest first, so cut-off names find the full one. */
  const people = []
  for (const [name] of [...counts].sort((a, b) => key(b[0]).length - key(a[0]).length || b[1] - a[1])) {
    const match = people.find((p) => p.spellings.some((s) => same(s, name)))
    if (match) match.spellings.push(name)
    else people.push({ spellings: [name] })
  }
  const canonical = new Map()
  for (const { spellings } of people) {
    const often = spellings.filter((s) => counts.get(s) >= 2)
    const pick = (often.length > 0 ? often : spellings).reduce((a, b) => (key(b).length > key(a).length ? b : a))
    for (const spelling of spellings) canonical.set(spelling, pick)
  }
  return canonical
}

module.exports = {
  isBorderGreen,
  findHighlight,
  highlightRuns,
  speechRegions,
  estimateLag,
  turns,
  scoredSpans,
  onKeptTimeline,
  cleanName,
  canonicalNames
}

// Recorded Zoom meetings from YouTube as an eval: the audio, and speaker turns read off the
// video's active-speaker border and name tiles (how, and what that can't see: zoom.cjs).
//
// Defaults are GitLab's public "Key Meeting" streams (GitLab Unfiltered) in Zoom gallery view,
// each tile named. Speaker view (one person full screen) isn't read yet. The videos are under YouTube's standard license, so they're
// downloaded to <dataDir>/zoom/<id>/ for this machine only and never go in the repo; nor do
// the names read off them. Needs yt-dlp and ffmpeg on the PATH; names are read with the OCR
// built into Windows (zoom-ocr.ps1), so it runs on Windows only for now.

const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { RATE, readWav, writeWav } = require('./wav.cjs')
const zoom = require('./zoom.cjs')

/**
 * GitLab Key Meetings that stay in gallery view (most of the series is recorded in speaker
 * view, which has no border to read): videos of 24, 21, 22 and 18 minutes.
 */
const DEFAULT_VIDEOS = ['qGFoZ8yodc4', 'FR6HO6o7PB0', 'JS1RRdfGUos', 'HurwHyh0yLc']
const QUICK_VIDEOS = ['qGFoZ8yodc4']

/** Frames are read at this size and rate: enough for the border, a quarter-second of timing. */
const WIDTH = 854
const HEIGHT = 480
const FPS = 4
/** Bump when the labelling changes, so cached references are made again. */
const VERSION = 1

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim().slice(-400)}`)
  return result.stdout
}

/** The video (480p at most, video only) and audio, once. */
function download(dir, id) {
  const has = (prefix) => readdirSync(dir).find((name) => name.startsWith(prefix) && !name.endsWith('.part'))
  for (const [prefix, format] of [
    ['video.', 'bv*[height<=480][ext=mp4]/bv*[height<=480]'],
    ['audio.', 'ba[ext=m4a]/ba']
  ]) {
    if (has(prefix)) continue
    process.stdout.write(`eval: downloading ${id} (${prefix.slice(0, -1)})\n`)
    run('yt-dlp', ['-q', '--no-warnings', '--no-playlist', '-f', format, '-o', join(dir, `${prefix}%(ext)s`), `https://www.youtube.com/watch?v=${id}`])
  }
  return { video: join(dir, has('video.')), audio: join(dir, has('audio.')) }
}

/** The highlighted box in every frame, streamed from ffmpeg (a 20-minute video is ~30 s). */
function scanFrames(video) {
  const size = WIDTH * HEIGHT * 3
  const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  const boxes = []
  let pending = Buffer.alloc(0)
  ffmpeg.stdout.on('data', (data) => {
    pending = Buffer.concat([pending, data])
    while (pending.length >= size) {
      boxes.push(zoom.findHighlight(pending.subarray(0, size), WIDTH, HEIGHT))
      pending = pending.subarray(size)
    }
  })
  return new Promise((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (status) => (status === 0 ? resolve(boxes) : reject(new Error(`ffmpeg exit ${status} reading ${video}`))))
  })
}

/** The name strip along the bottom of a tile: about a fifth of its height, three quarters of its width. */
function nameStrip(box) {
  const height = Math.max(12, Math.round((box.y1 - box.y0) * 0.19))
  return { x: box.x0 + 2, y: box.y1 - height - 1, w: Math.round((box.x1 - box.x0) * 0.75), h: height }
}

/** Crops each run's name strip at up to three moments and reads them; returns texts per run. */
function readNames(dir, video, runs) {
  const crops = join(dir, 'names')
  mkdirSync(crops, { recursive: true })
  const jobs = []
  runs.forEach((highlight, index) => {
    if (!highlight.box) return
    const length = highlight.end - highlight.start
    const moments = length > 6 ? [0.25, 0.5, 0.75] : [0.5]
    moments.forEach((at, k) => {
      const path = join(crops, `${index}-${k}.png`)
      const { x, y, w, h } = nameStrip(highlight.box)
      // Scaled up 4x: Windows' OCR misses text this small at its own size.
      const filter = `scale=${WIDTH}:${HEIGHT},crop=${w}:${h}:${x}:${y},scale=iw*4:ih*4:flags=lanczos`
      const time = (highlight.start + length * at).toFixed(2)
      if (!existsSync(path)) run('ffmpeg', ['-v', 'error', '-y', '-ss', time, '-i', video, '-frames:v', '1', '-vf', filter, path])
      jobs.push({ index, path })
    })
  })
  const texts = new Map(jobs.map(({ path }) => [path, '']))
  const script = join(__dirname, 'zoom-ocr.ps1')
  // A few dozen paths per call keeps the command line short of Windows' limit.
  for (let at = 0; at < jobs.length; at += 40) {
    const out = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...jobs.slice(at, at + 40).map((j) => j.path)])
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const { path, text } = JSON.parse(line)
      texts.set(path, text)
    }
  }
  const byRun = new Map()
  for (const { index, path } of jobs) byRun.set(index, [...(byRun.get(index) ?? []), texts.get(path)])
  return byRun
}

/** The audio as 16 kHz mono, once. */
function audioWav(dir, audio) {
  const wav = join(dir, 'audio.wav')
  if (!existsSync(wav)) {
    run('ffmpeg', ['-v', 'error', '-y', '-i', audio, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', `${wav}.tmp.wav`])
    renameSync(`${wav}.tmp.wav`, wav)
  }
  return wav
}

/** Makes (or reuses) one video's audio and reference. `minutes` = 0 keeps all of it. */
async function prepare(dataDir, id, { minutes = 0 } = {}) {
  if (process.platform !== 'win32') throw new Error('the Zoom eval reads names with Windows OCR; run it on Windows')
  if (!/^[\w-]{11}$/.test(id)) throw new Error(`not a YouTube video id: ${id}`)
  const dir = join(dataDir, 'zoom', id)
  mkdirSync(dir, { recursive: true })
  const labelsPath = join(dir, 'labels.json')
  let labels = existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, 'utf8')) : null
  if (!labels || labels.version !== VERSION) {
    const { video, audio } = download(dir, id)
    const wav = audioWav(dir, audio)
    process.stdout.write(`eval: reading who is highlighted in ${id}\n`)
    const runs = zoom.highlightRuns(await scanFrames(video), FPS)
    const texts = readNames(dir, video, runs)
    const cleaned = new Map([...texts].map(([index, list]) => [index, list.map(zoom.cleanName).filter(Boolean)]))
    const canonical = zoom.canonicalNames([...cleaned.values()].flat())
    const names = {}
    for (const [index, list] of cleaned) {
      // The name most of a run's readings agree on.
      const votes = new Map()
      for (const name of list.map((n) => canonical.get(n))) votes.set(name, (votes.get(name) ?? 0) + 1)
      const top = [...votes].sort((a, b) => b[1] - a[1])[0]
      if (top) names[index] = top[0]
    }
    const samples = readWav(wav)
    const speech = zoom.speechRegions(samples, RATE)
    const lag = zoom.estimateLag(runs, speech)
    const spans = zoom.scoredSpans(runs)
    labels = { version: VERSION, id, fps: FPS, lag, spans, runs, names, ocr: Object.fromEntries(texts) }
    writeFileSync(labelsPath, JSON.stringify(labels, null, 1))
  }
  const wavAll = join(dir, 'audio.wav')
  const samples = readWav(wavAll)
  const speech = zoom.speechRegions(samples, RATE)
  const all = zoom.turns(labels.runs.map((run, index) => ({ ...run, index })), speech, (run) => labels.names[run.index] ?? null, labels.lag.lag)
  let spans = labels.spans.map((s) => ({ start: Math.max(0, s.start - labels.lag.lag), end: Math.min(samples.length / RATE, s.end - labels.lag.lag) }))
  if (minutes > 0) {
    // The first `minutes` of kept audio.
    let left = minutes * 60
    spans = spans.flatMap((s) => {
      if (left <= 0) return []
      const end = Math.min(s.end, s.start + left)
      left -= end - s.start
      return [{ start: s.start, end }]
    })
  }
  const pieces = spans.map((s) => samples.subarray(Math.round(s.start * RATE), Math.round(s.end * RATE)))
  const kept = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    kept.set(piece, offset)
    offset += piece.length
  }
  const wav = join(dir, `kept${minutes > 0 ? `.${minutes}m` : ''}.wav`)
  writeWav(wav, kept)
  return { id: `zoom-${id}`, wav, seconds: kept.length / RATE, reference: { segments: zoom.onKeptTimeline(all, spans) } }
}

module.exports = { DEFAULT_VIDEOS, QUICK_VIDEOS, prepare, nameStrip }

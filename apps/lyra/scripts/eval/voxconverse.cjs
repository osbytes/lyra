// VoxConverse v0.3 (CC BY 4.0, VGG Oxford; copyright of the audio stays with the videos'
// owners): multi-speaker clips of debates, news and talk shows from YouTube, with hand-checked
// speaker turns as RTTM. https://www.robots.ox.ac.uk/~vgg/data/voxconverse/
//
// Speaker turns only, no words: it scores DER and the speaker count, not WER or cpWER. Real
// voices Lyra was never tuned on, so it is the held-out check the sessions can't be.
//
// Labels come from the authors' repository at a pinned commit (~3 MB, once). Oxford's audio
// zips now ask for a login, so the test WAVs come one at a time (~5–15 MB each) from a CC BY
// 4.0 mirror at a pinned revision. Both go to <dataDir>/voxconverse/. Citation: Chung et al.,
// "Spot the conversation: speaker diarisation in the wild", Interspeech 2020.

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { download } = require('./ami.cjs')
const { RATE, readWav, writeWav } = require('./wav.cjs')

const LABELS_COMMIT = '24bf60be297701cd7e4ef18550c6d390c1b87365'
const LABELS_URL = `https://codeload.github.com/joonson/voxconverse/tar.gz/${LABELS_COMMIT}`
const AUDIO_REVISION = '7e3ea2807400b9ed79451e20513f7a50ac4fd846'
const AUDIO_URL = (file) =>
  `https://huggingface.co/datasets/ggfox00000/dia-voxconverse-test/resolve/${AUDIO_REVISION}/audio/test/${file}.wav`

/**
 * Test files of 4–7 minutes, one for each of 2 to 6 people and one of 8, about 31 minutes in
 * all; `fyqoe` has the most overlapped speech of them (a fifth of its speech time).
 */
const DEFAULT_FILES = ['tkhgs', 'fyqoe', 'nprxc', 'rpkso', 'xvxwv', 'qadia']
/** 2, 3 and 5 people: about 15 minutes. */
const QUICK_FILES = ['tkhgs', 'fyqoe', 'rpkso']

/** Reference segments from an RTTM file's SPEAKER lines, in time order. */
function parseRttm(text) {
  const segments = []
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== 'SPEAKER' || fields.length < 8) continue
    const start = Number(fields[3])
    const duration = Number(fields[4])
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue
    segments.push({ speaker: fields[7], start, end: start + duration, text: '' })
  }
  return segments.sort((a, b) => a.start - b.start)
}

/** The segments that start before `seconds`, cut at it. */
function clip(segments, seconds) {
  return segments.filter((s) => s.start < seconds).map((s) => ({ ...s, end: Math.min(s.end, seconds) }))
}

/** One fetch of the labels per run, however many files are prepared at once (`--jobs`). */
let labels = null
function ensureLabels(dir) {
  labels ??= fetchLabels(dir).catch((error) => {
    labels = null
    throw error
  })
  return labels
}

async function fetchLabels(dir) {
  const root = join(dir, `voxconverse-${LABELS_COMMIT}`)
  if (existsSync(join(root, 'test'))) return root
  const archive = join(dir, `labels-${LABELS_COMMIT}.tar.gz`)
  await download(LABELS_URL, archive)
  // GNU tar and bsdtar (Windows 10+, macOS) both read gzip.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const result = spawnSync(tar, ['-xzf', archive, '-C', dir], { stdio: 'inherit' })
  if (result.status !== 0 || !existsSync(join(root, 'test'))) throw new Error(`could not extract ${archive}`)
  return root
}

/**
 * Prepares one VoxConverse test file: the WAV to feed Lyra and its reference turns.
 * `minutes` = 0 (the default) keeps the whole file.
 */
async function prepare(dataDir, file, { minutes = 0 } = {}) {
  if (!/^[a-z]{5}$/.test(file)) throw new Error(`not a VoxConverse file id: ${file}`)
  const dir = join(dataDir, 'voxconverse')
  mkdirSync(join(dir, 'audio'), { recursive: true })
  const rttm = join(await ensureLabels(dir), 'test', `${file}.rttm`)
  if (!existsSync(rttm)) throw new Error(`${file} is not in the VoxConverse test split`)
  const full = join(dir, 'audio', `${file}.wav`)
  await download(AUDIO_URL(file), full)
  let wav = full
  let samples = readWav(full)
  if (minutes > 0 && samples.length > minutes * 60 * RATE) {
    samples = samples.subarray(0, minutes * 60 * RATE)
    wav = join(dir, 'audio', `${file}.${minutes}m.wav`)
    writeWav(wav, samples)
  }
  const seconds = samples.length / RATE
  return {
    id: `vox-${file}`,
    wav,
    seconds,
    reference: { segments: clip(parseRttm(readFileSync(rttm, 'utf8')), seconds) }
  }
}

module.exports = { DEFAULT_FILES, QUICK_FILES, prepare, parseRttm, clip }

// AMI Meeting Corpus (CC BY 4.0, University of Edinburgh): audio plus a reference transcript
// with a speaker on every word. https://groups.inf.ed.ac.uk/ami/corpus/
//
// Downloads go to <dataDir>/ami/ and are reused: the manual annotations (~23 MB) once, then
// one WAV per meeting and mic (~35–70 MB). Citation: Carletta et al., "The AMI Meeting Corpus",
// MLMI 2005.

const { spawnSync } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } = require('node:fs')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { RATE, readWav, writeWav } = require('./wav.cjs')

const ANNOTATIONS_URL = 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip'
/**
 * Edinburgh first. The upstream server is often down for maintenance, so headset mixes of the
 * test meetings fall back to FluidInference's CC BY 4.0 mirror, which carries only those.
 */
const AUDIO_URLS = (meeting, mic) => [
  `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${meeting}/audio/${meeting}.${mic}.wav`,
  ...(mic === 'Mix-Headset'
    ? [`https://huggingface.co/datasets/FluidInference/ami-corpus-mirror/resolve/main/sdm/${meeting}.${mic}.wav`]
    : [])
]

/**
 * Mics a laptop recording resembles most. `Array1-01` is one channel of the table-top array
 * (far field, like Lyra on a laptop); `Mix-Headset` is the close-talk mix (easy mode).
 */
const MICS = ['Array1-01', 'Mix-Headset']

/** One meeting from each scenario family in the standard AMI test split. */
const DEFAULT_MEETINGS = ['ES2004a', 'IS1009a', 'TS3003a']

/** Words closer than this join one reference segment, so DER isn't scored between every word. */
const JOIN_GAP = 0.3

/** Fetches the first of `urls` that answers, into `path`. */
async function download(urls, path) {
  if (existsSync(path)) return
  const failures = []
  for (const url of [urls].flat()) {
    process.stdout.write(`eval: downloading ${url}\n`)
    let response
    try {
      response = await fetch(url)
    } catch (error) {
      // Connection resets count as "down" too, so the next mirror gets a turn.
      failures.push(`${error.cause?.code ?? error.message} ${url}`)
      continue
    }
    if (!response.ok || !response.body) {
      failures.push(`${response.status} ${url}`)
      continue
    }
    const partial = `${path}.partial`
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    renameSync(partial, path)
    return
  }
  throw new Error(`download failed: ${failures.join('; ')}`)
}

async function ensureAnnotations(dir) {
  const words = join(dir, 'annotations', 'words')
  if (existsSync(words)) return words
  const zip = join(dir, 'ami_public_manual_1.6.2.zip')
  await download(ANNOTATIONS_URL, zip)
  mkdirSync(join(dir, 'annotations'), { recursive: true })
  // bsdtar reads zips and ships with Windows 10+ and macOS; GNU tar (Git Bash, Linux) doesn't.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  let result = spawnSync(tar, ['-xf', zip, '-C', join(dir, 'annotations')], { stdio: 'inherit' })
  if (result.status !== 0) result = spawnSync('unzip', ['-q', '-o', zip, '-d', join(dir, 'annotations')], { stdio: 'inherit' })
  if (result.status !== 0 || !existsSync(words)) throw new Error(`could not extract ${zip}`)
  return words
}

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')

/** Timed, non-punctuation words from one `<meeting>.<speaker>.words.xml` file. */
function parseWords(xml) {
  const out = []
  for (const match of xml.matchAll(/<w\b([^>]*)>([^<]*)<\/w>/g)) {
    const attrs = match[1]
    if (/\bpunc="true"/.test(attrs)) continue
    const start = /\bstarttime="([\d.]+)"/.exec(attrs)
    const end = /\bendtime="([\d.]+)"/.exec(attrs)
    // A few words have no timing; they can't be placed, so leave them out of both metrics.
    if (!start || !end) continue
    out.push({ start: +start[1], end: +end[1], text: decode(match[2]).trim() })
  }
  return out
}

/** Reference segments for a meeting: each speaker's words, joined across short gaps. */
function reference(wordsDir, meeting, seconds) {
  const files = readdirSync(wordsDir).filter((name) => name.startsWith(`${meeting}.`) && name.endsWith('.words.xml'))
  if (files.length === 0) throw new Error(`no AMI word annotations for ${meeting}`)
  const segments = []
  for (const file of files) {
    const speaker = file.split('.')[1]
    // The annotation files are Latin-1 (see their XML declaration).
    const words = parseWords(readFileSync(join(wordsDir, file), 'latin1')).filter((w) => w.start < seconds)
    let current = null
    for (const word of words) {
      if (current && word.start - current.end <= JOIN_GAP) {
        current.end = Math.max(current.end, Math.min(word.end, seconds))
        current.text += ` ${word.text}`
      } else {
        current = { speaker, start: word.start, end: Math.min(word.end, seconds), text: word.text }
        segments.push(current)
      }
    }
  }
  return { segments: segments.sort((a, b) => a.start - b.start) }
}

/** Writes the first `seconds` of `source` to `target` and returns the excerpt length. */
function excerpt(source, target, seconds) {
  const samples = readWav(source)
  const part = samples.subarray(0, Math.min(samples.length, Math.floor(seconds * RATE)))
  writeWav(target, part)
  return part.length / RATE
}

/**
 * Prepares one AMI meeting: the WAV excerpt to feed Lyra and the matching reference.
 * `minutes` = 0 keeps the whole meeting.
 */
async function prepare(dataDir, meeting, { mic = MICS[0], minutes = 10 } = {}) {
  if (!MICS.includes(mic)) throw new Error(`unknown AMI mic ${mic}; use one of ${MICS.join(', ')}`)
  if (!/^[A-Z]{2}\d{4}[a-z]$/.test(meeting)) throw new Error(`not an AMI meeting id: ${meeting}`)
  const dir = join(dataDir, 'ami')
  mkdirSync(join(dir, 'audio'), { recursive: true })
  const wordsDir = await ensureAnnotations(dir)
  const full = join(dir, 'audio', `${meeting}.${mic}.wav`)
  await download(AUDIO_URLS(meeting, mic), full)
  const limit = minutes > 0 ? minutes * 60 : Infinity
  const wav = join(dir, 'audio', `${meeting}.${mic}.${minutes > 0 ? `${minutes}m` : 'full'}.wav`)
  const seconds = excerpt(full, wav, limit)
  return { id: `${meeting}.${mic}`, wav, seconds, reference: reference(wordsDir, meeting, seconds) }
}

module.exports = { DEFAULT_MEETINGS, MICS, download, prepare, parseWords, reference }

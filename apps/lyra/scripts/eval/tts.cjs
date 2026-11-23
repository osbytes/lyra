// Synthetic speech for eval scenarios, so they need no recordings of real people.
// Windows uses the SAPI voices (David, Zira); macOS uses `say` (Daniel, Samantha).
// Clips are cached by voice and text under <dir>.

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/** Two clearly different voices; scenarios only ever need two. */
const VOICES = {
  win32: ['Microsoft David Desktop', 'Microsoft Zira Desktop'],
  darwin: ['Daniel', 'Samantha']
}

function voices() {
  const list = VOICES[process.platform]
  if (!list) throw new Error(`no TTS voices configured for ${process.platform}; call scenarios need Windows or macOS`)
  return list
}

/**
 * Renders `{ voice: 0 | 1, text, pitch?, rate? }` lines to WAV files and returns their paths, in
 * order. `pitch` / `rate` (SSML values like '+20%') shift a voice so it can play a second person
 * who sounds close to the first; Windows only.
 */
function render(lines, dir) {
  mkdirSync(dir, { recursive: true })
  const names = voices()
  const jobs = lines.map(({ voice, text, pitch, rate }) => {
    const name = names[voice]
    const key = createHash('sha1').update(`${name}\n${pitch ?? ''}\n${rate ?? ''}\n${text}`).digest('hex').slice(0, 16)
    return { voice: name, text, out: join(dir, `${key}.wav`), ...(pitch ? { pitch, rate: rate ?? '0%' } : {}) }
  })
  if (process.platform !== 'win32' && jobs.some((job) => job.pitch)) {
    throw new Error('similar-voice scenarios need Windows (SAPI SSML); skip them on macOS')
  }
  const todo = jobs.filter((job) => !existsSync(job.out))
  if (todo.length > 0 && process.platform === 'win32') {
    const file = join(dir, 'jobs.json')
    writeFileSync(file, JSON.stringify(todo))
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'tts.ps1'), '-Jobs', file],
      { stdio: 'inherit' }
    )
    if (result.status !== 0) throw new Error('SAPI speech synthesis failed')
  } else {
    for (const job of todo) {
      const result = spawnSync('say', ['-v', job.voice, '-o', job.out, '--file-format=WAVE', '--data-format=LEI16@16000', job.text], {
        stdio: 'inherit'
      })
      if (result.status !== 0) throw new Error(`say failed for voice ${job.voice}`)
    }
  }
  return jobs.map((job) => job.out)
}

module.exports = { render }

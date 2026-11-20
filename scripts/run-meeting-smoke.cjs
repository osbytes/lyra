// Runs the real meeting pipeline on a 16 kHz mono 16-bit WAV in a throwaway profile:
//   pnpm smoke:meeting path/to/meeting.wav
// Downloads the speech and speaker models on first use (~180 MB).
const { spawnSync } = require('node:child_process')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const electron = require('electron')

const wav = process.argv[2]
if (!wav) {
  console.error('usage: pnpm smoke:meeting <file.wav>')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'lyra-meeting-'))
const result = spawnSync(electron, ['.', `--user-data-dir=${join(home, 'data')}`], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, LYRA_MEETING_FIXTURE: resolve(wav), USERPROFILE: home, HOME: home },
  stdio: 'inherit'
})
process.exit(result.status ?? 1)

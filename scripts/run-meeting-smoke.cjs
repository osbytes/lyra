// Runs the real meeting pipeline on a 16 kHz mono 16-bit WAV in a throwaway profile:
//   pnpm smoke:meeting path/to/meeting.wav [path/to/system.wav]
// The optional second file is the system-audio track (the other side of a call).
// Downloads the speech and speaker models on first use (~180 MB); set LYRA_MODELS_DIR to keep them.
// LYRA_NOTES_ENGINE=local|claude also writes meeting notes (local downloads a ~2 GB model).
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const electron = require('electron')

/** Child processes can hold files for a moment after exit (Windows), so retry; never fail the run. */
function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.warn('could not remove ' + path + ': ' + error.message)
  }
}

const wav = process.argv[2]
if (!wav) {
  console.error('usage: pnpm smoke:meeting <file.wav>')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'lyra-meeting-'))
const result = spawnSync(electron, ['.', `--user-data-dir=${join(home, 'data')}`], {
  cwd: join(__dirname, '..'),
  env: {
    ...process.env,
    LYRA_MEETING_FIXTURE: resolve(wav),
    ...(process.argv[3] ? { LYRA_MEETING_SYSTEM_FIXTURE: resolve(process.argv[3]) } : {}),
    USERPROFILE: home,
    HOME: home
  },
  stdio: 'inherit'
})
// Test runs keep their profile in a per-process temp folder; don't leave it (or models) behind.
removeQuietly(home)
if (result.pid) removeQuietly(join(tmpdir(), 'voice-pages-smoke-' + result.pid))
process.exit(result.status ?? 1)

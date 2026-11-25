// Runs the real meeting pipeline on a 16 kHz mono 16-bit WAV in a throwaway profile:
//   pnpm smoke:meeting path/to/meeting.wav [path/to/system.wav] [options]
// The optional second file is the system-audio track (the other side of a call). Options:
//   --offline             diarize then transcribe, instead of replaying as a live recording
//   --no-relabel          keep the live pass's speakers (no relabel after stop)
//   --notes local|claude  also write meeting notes (local downloads a ~2 GB model)
//   --output <file.json>  write the labeled segments for the eval scorers
//   --enroll <file.wav>   first save this as the laptop owner's voice, as People would
// Downloads the speech and speaker models on first use (~180 MB); set LYRA_MODELS_DIR to keep them.
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

const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('--')) {
  console.error('usage: pnpm smoke:meeting <file.wav> [system.wav] [options]')
  process.exit(1)
}
// The app runs from apps/lyra, so paths given relative to here are made absolute first.
const forApp = args.map((arg, i) =>
  !arg.startsWith('--') && (i < 2 || args[i - 1] === '--output' || args[i - 1] === '--enroll') && args[i - 1] !== '--notes'
    ? resolve(arg)
    : arg
)

const home = mkdtempSync(join(tmpdir(), 'lyra-meeting-'))
// A test run has no business in the real keychain; Chromium's mock stands in for it.
const result = spawnSync(electron, ['.', `--user-data-dir=${join(home, 'data')}`, '--use-mock-keychain', 'meeting', ...forApp], {
  cwd: join(__dirname, '..'),
  env: {
    ...process.env,
    // Not on macOS: the login keychain is found through HOME, and a HOME without one makes
    // macOS offer to reset the keychain. The profile and notes are already throwaway there.
    ...(process.platform === 'darwin' ? {} : { USERPROFILE: home, HOME: home })
  },
  stdio: 'inherit'
})
// Test runs keep their profile in a per-process temp folder; don't leave it (or models) behind.
removeQuietly(home)
if (result.pid) removeQuietly(join(tmpdir(), 'lyra-task-' + result.pid))
process.exit(result.status ?? 1)

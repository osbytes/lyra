const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const electron = require('electron')

/** Child processes can hold files for a moment after exit (Windows), so retry; never fail the run. */
function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.warn('could not remove ' + path + ': ' + error.message)
  }
}

process.env.VOICE_PAGES_SMOKE = '1'
const result = spawnSync(electron, ['.'], {
  cwd: require('node:path').join(__dirname, '..'),
  env: process.env,
  stdio: 'inherit'
})

// The app keeps its test profile in a per-process temp folder; clean it up.
if (result.pid) removeQuietly(join(tmpdir(), 'voice-pages-smoke-' + result.pid))
process.exit(result.status ?? 1)

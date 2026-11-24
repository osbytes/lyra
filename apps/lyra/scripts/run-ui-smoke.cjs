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

const result = spawnSync(electron, ['.', 'smoke'], {
  cwd: join(__dirname, '..'),
  // A fake key, so the smoke test can prove ANTHROPIC_API_KEY is picked up and never logged.
  env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-smoke-not-a-real-key' },
  stdio: 'inherit'
})

// The app keeps its test profile in a per-process temp folder; clean it up.
if (result.pid) removeQuietly(join(tmpdir(), 'lyra-task-' + result.pid))
process.exit(result.status ?? 1)

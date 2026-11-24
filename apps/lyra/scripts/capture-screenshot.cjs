// pnpm screenshot                  the README shot (docs/screenshot.png)
// pnpm screenshot --review <dir>   every UI state in both themes, for review
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const electron = require('electron')

const args = process.argv.slice(2)
const review = args.indexOf('--review')
if (review !== -1 && args[review + 1]) args[review + 1] = resolve(args[review + 1])
const result = spawnSync(electron, ['.', 'screenshot', ...args], {
  cwd: join(__dirname, '..'),
  stdio: 'inherit'
})

process.exit(result.status ?? 1)

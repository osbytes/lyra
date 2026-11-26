// pnpm screenshot                  the README shot (docs/screenshot.png)
// pnpm screenshot --review <dir>   every UI state in both themes, for review
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const electron = require('electron')

const args = process.argv.slice(2)
const review = args.indexOf('--review')
if (review !== -1 && args[review + 1]) args[review + 1] = resolve(args[review + 1])
// Chromium switches go before the app path, where the task parser leaves them alone. 2x matches
// a Retina capture on any display; without the occlusion switch, Windows stops painting a window
// another one covers and capturePage fails with UnknownVizError.
const chromium = ['--force-device-scale-factor=2', '--disable-features=CalculateNativeWinOcclusion']
const result = spawnSync(electron, [...chromium, '.', 'screenshot', ...args], {
  cwd: join(__dirname, '..'),
  stdio: 'inherit'
})

process.exit(result.status ?? 1)

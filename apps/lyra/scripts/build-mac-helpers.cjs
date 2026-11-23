// Compiles the small native helpers Lyra ships on macOS (see native/mac).
const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') {
  console.log('build-mac-helpers: not on macOS, skipping')
  process.exit(0)
}

const root = join(__dirname, '..')
const outDir = join(root, 'build', 'helpers')
mkdirSync(outDir, { recursive: true })

const out = join(outDir, 'micwatch')
execFileSync('swiftc', ['-O', join(root, 'native', 'mac', 'micwatch.swift'), '-o', out], {
  stdio: 'inherit'
})
console.log(`build-mac-helpers: built ${out}`)

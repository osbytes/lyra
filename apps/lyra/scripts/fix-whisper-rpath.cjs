const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

// Resolved, not assumed: with pnpm's hoisted linker the addon sits in the workspace root's
// node_modules, not this package's, and a wrong guess here patches nothing without a word.
function addonDist() {
  try {
    return join(dirname(require.resolve('@kutalia/whisper-node-addon/package.json')), 'dist')
  } catch {
    return null
  }
}

const DIST = addonDist()
if (DIST === null) {
  console.error('fix-whisper-rpath: @kutalia/whisper-node-addon is not installed; nothing patched')
  process.exit(0)
}
const CI_RPATH =
  '/Users/runner/work/whisper-node-addon/whisper-node-addon/deps/whisper.cpp/build/Release'

function run(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function patchMac(dir) {
  if (!existsSync(dir)) return 0
  const files = readdirSync(dir).filter((name) => name.endsWith('.dylib') || name.endsWith('.node'))
  for (const name of files) {
    const file = join(dir, name)
    run('install_name_tool', ['-add_rpath', '@loader_path', file])
    run('install_name_tool', ['-delete_rpath', CI_RPATH, file])
    run('codesign', ['--force', '--sign', '-', file])
  }
  return files.length
}

function patchLinux(dir) {
  if (!existsSync(dir)) return
  const files = readdirSync(dir).filter((name) => name.endsWith('.so') || name.endsWith('.node') || name.includes('.so.'))
  for (const name of files) {
    const file = join(dir, name)
    run('patchelf', ['--set-rpath', '$ORIGIN', file])
  }
}

if (process.platform === 'darwin') {
  const patched = patchMac(join(DIST, 'mac-arm64')) + patchMac(join(DIST, 'mac-x64'))
  // The unpatched addon looks for libwhisper where its CI built it, and fails to load.
  if (patched === 0) {
    console.error(`fix-whisper-rpath: no macOS binaries under ${DIST}; the addon will not load`)
    process.exit(1)
  }
  console.log(`Patched whisper.cpp rpaths for macOS (@loader_path): ${String(patched)} files`)
} else if (process.platform === 'linux') {
  patchLinux(join(DIST, 'linux-x64'))
  patchLinux(join(DIST, 'linux-arm64'))
  console.log('Patched whisper.cpp rpaths for Linux ($ORIGIN)')
}

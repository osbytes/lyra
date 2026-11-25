const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

// Resolve rather than hardcode: with `node-linker=hoisted` pnpm puts the addon in the repo
// root's node_modules, not apps/lyra's, and a missed patch fails only at runtime.
function addonDist() {
  try {
    const pkg = require.resolve('@kutalia/whisper-node-addon/package.json', {
      paths: [join(__dirname, '..')],
    })
    return join(dirname(pkg), 'dist')
  } catch {
    return null
  }
}

const DIST = addonDist()
if (!DIST) {
  console.warn('fix-whisper-rpath: @kutalia/whisper-node-addon not found; nothing patched')
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
  if (!existsSync(dir)) return
  const files = readdirSync(dir).filter((name) => name.endsWith('.dylib') || name.endsWith('.node'))
  for (const name of files) {
    const file = join(dir, name)
    run('install_name_tool', ['-add_rpath', '@loader_path', file])
    run('install_name_tool', ['-delete_rpath', CI_RPATH, file])
    run('codesign', ['--force', '--sign', '-', file])
  }
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
  patchMac(join(DIST, 'mac-arm64'))
  patchMac(join(DIST, 'mac-x64'))
  console.log('Patched whisper.cpp rpaths for macOS (@loader_path)')
} else if (process.platform === 'linux') {
  patchLinux(join(DIST, 'linux-x64'))
  patchLinux(join(DIST, 'linux-arm64'))
  console.log('Patched whisper.cpp rpaths for Linux ($ORIGIN)')
}

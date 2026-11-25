// Installs node-llama-cpp, with its own complete dependency tree, into build/llama for packaging.
//
// electron-builder's pnpm dependency collector mixes up same-named packages at different
// versions in node-llama-cpp's tree (e.g. signal-exit 3 vs 4), which breaks it at runtime in
// packaged apps. A plain npm install shipped as an extra resource sidesteps that: Lyra's notes
// worker loads it from <resources>/llama/node_modules in packaged builds.
//
// The tree is pinned: scripts/llama/package-lock.json (every platform's prebuilt binary package,
// with integrity hashes) is installed with `npm ci`, so a release ships exactly the reviewed tree.
// Install scripts don't run. node-llama-cpp's postinstall only loads (or, failing that, builds
// from source) the binding; its prebuilt binaries arrive as optional dependency packages
// (@node-llama-cpp/<platform>), so the load is checked here explicitly instead.
//
// To bump: set the version in package.json (devDependencies) and scripts/llama/package.json,
// then run `npm install --package-lock-only --ignore-scripts` in scripts/llama and commit both.
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pinned = join(__dirname, 'llama')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const version = readJson(join(root, 'package.json')).devDependencies?.['node-llama-cpp']
if (!version) throw new Error('node-llama-cpp must be listed in devDependencies')
const manifest = readJson(join(pinned, 'package.json')).dependencies?.['node-llama-cpp']
const locked = readJson(join(pinned, 'package-lock.json')).packages?.['node_modules/node-llama-cpp']
  ?.version
if (manifest !== version || locked !== version) {
  throw new Error(
    `node-llama-cpp versions disagree: package.json ${version}, scripts/llama/package.json ` +
      `${manifest}, scripts/llama/package-lock.json ${locked}. Bump them together (see the top of ` +
      'scripts/prepare-llama.cjs).'
  )
}

const dir = join(root, 'build', 'llama')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
copyFileSync(join(pinned, 'package.json'), join(dir, 'package.json'))
copyFileSync(join(pinned, 'package-lock.json'), join(dir, 'package-lock.json'))

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args) =>
  execFileSync(npm, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
run(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])

// CUDA builds are ~575 MB; Vulkan (Windows/Linux) and Metal (macOS) cover GPUs.
const scoped = join(dir, 'node_modules', '@node-llama-cpp')
if (existsSync(scoped)) {
  for (const name of readdirSync(scoped)) {
    if (name.includes('cuda')) rmSync(join(scoped, name), { recursive: true, force: true })
  }
}

// What the skipped postinstall would have found: this platform's prebuilt binding. Without it
// node-llama-cpp would try to build llama.cpp from source on the user's machine, so a missing
// binary fails the build instead. (Loading it here isn't possible everywhere: the macOS arm64
// binary needs Metal, which CI runners don't have.)
const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const prefix = `${os}-${process.arch}`
const binaries = (existsSync(scoped) ? readdirSync(scoped) : [])
  .filter((name) => name.startsWith(prefix))
  .filter((name) => existsSync(join(scoped, name, 'bins', name, 'llama-addon.node')))
if (binaries.length === 0) {
  throw new Error(`prepare-llama: no prebuilt node-llama-cpp binary for ${prefix} was installed`)
}
console.log(`prepare-llama: prebuilt binaries ${binaries.join(', ')}`)
console.log(`prepare-llama: node-llama-cpp ${version} ready in ${dir}`)

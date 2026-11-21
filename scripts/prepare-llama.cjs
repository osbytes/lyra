// Installs node-llama-cpp, with its own complete dependency tree, into build/llama for packaging.
//
// electron-builder's pnpm dependency collector mixes up same-named packages at different
// versions in node-llama-cpp's tree (e.g. signal-exit 3 vs 4), which breaks it at runtime in
// packaged apps. A plain npm install shipped as an extra resource sidesteps that: Lyra's notes
// worker loads it from <resources>/llama/node_modules in packaged builds.
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const version = require(join(root, 'package.json')).devDependencies['node-llama-cpp']
if (!version) throw new Error('node-llama-cpp must be listed in devDependencies')

const dir = join(root, 'build', 'llama')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'lyra-llama', private: true, dependencies: { 'node-llama-cpp': version } }, null, 2)
)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: dir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

// CUDA builds are ~575 MB; Vulkan (Windows/Linux) and Metal (macOS) cover GPUs.
const scoped = join(dir, 'node_modules', '@node-llama-cpp')
if (existsSync(scoped)) {
  for (const name of readdirSync(scoped)) {
    if (name.includes('cuda')) rmSync(join(scoped, name), { recursive: true, force: true })
  }
}
console.log(`prepare-llama: node-llama-cpp ${version} ready in ${dir}`)

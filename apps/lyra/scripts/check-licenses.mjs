// Fails when a package Lyra ships has a licence outside the allowlist, so a new copyleft or
// unlicensed dependency is a decision, not an accident. Covers the production dependencies in
// pnpm-lock.yaml and the node-llama-cpp tree prepare-llama.cjs ships (scripts/llama).
//
//   pnpm --filter lyra licenses list --prod --json > licenses.json
//   node scripts/check-licenses.mjs licenses.json
//
// Run weekly by .github/workflows/security.yml. Bundled renderer packages (React, Tiptap) are
// devDependencies and are covered by THIRD_PARTY.md rather than this check.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Permissive licences: attribution at most, nothing that reaches Lyra's own licence. */
export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense'
])

/**
 * Whether an SPDX expression is allowed: one alternative of an `OR` is enough, every part of an
 * `AND` must be. Parentheses only group, which this flat reading covers for the shapes npm uses.
 */
export function isAllowed(expression) {
  const flat = expression.replaceAll(/[()]/g, ' ').trim()
  if (!flat) return false
  return flat
    .split(/\s+OR\s+/)
    .some((alternative) => alternative.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())))
}

/** `{ licence: [{ name, versions }] }` from `pnpm licenses list --json` as `name@version` per licence. */
function fromPnpm(report) {
  return Object.entries(report).flatMap(([license, packages]) =>
    packages.flatMap((pkg) => pkg.versions.map((version) => ({ id: `${pkg.name}@${version}`, license })))
  )
}

/** Every installed package in an npm lockfile (v3) with its declared licence. */
function fromNpmLock(lock) {
  return Object.entries(lock.packages)
    .filter(([path]) => path !== '')
    .map(([path, entry]) => ({
      id: `${path.replace(/^.*node_modules\//, '')}@${entry.version}`,
      license: entry.license ?? 'UNKNOWN'
    }))
}

function main() {
  const [reportPath] = process.argv.slice(2)
  if (!reportPath) {
    console.error('usage: node scripts/check-licenses.mjs <pnpm-licenses.json>')
    process.exit(2)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const packages = [
    ...fromPnpm(JSON.parse(readFileSync(reportPath, 'utf8'))),
    ...fromNpmLock(JSON.parse(readFileSync(join(here, 'llama', 'package-lock.json'), 'utf8')))
  ]
  const refused = packages.filter((pkg) => !isAllowed(pkg.license))
  for (const pkg of refused) console.error(`not on the licence allowlist: ${pkg.id} (${pkg.license})`)
  if (refused.length) process.exit(1)
  console.log(`licences: ${String(packages.length)} packages, all on the allowlist`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

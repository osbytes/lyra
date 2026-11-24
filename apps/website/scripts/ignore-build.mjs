// Vercel's Ignored Build Step (`ignoreCommand` in vercel.json): exit 0 skips the deployment, exit 1
// builds it. Runs from apps/website.
//
// Diffs against the last successful deployment rather than `HEAD^`: `HEAD^` only sees the newest
// commit, so a push whose last commit misses the site (a release merge, say) was skipped even when
// earlier commits in it, or a failed deploy before it, changed the site. With no deployment to
// compare against, or one too old for Vercel's shallow clone, it builds.
import { spawnSync } from 'node:child_process'

// The site, the lockfile it installs from, and the app stylesheet the demo is drawn with.
const PATHS = ['.', '../../pnpm-lock.yaml', '../lyra/src/renderer/src/assets/styles.css']

function git(args, stderr = 'inherit') {
  return spawnSync('git', args, { stdio: ['ignore', 'ignore', stderr] }).status
}

function decide(build, reason) {
  console.log(`${build ? 'Building' : 'Skipping'}: ${reason}`)
  process.exit(build ? 1 : 0)
}

const previous = process.env.VERCEL_GIT_PREVIOUS_SHA
if (!previous) decide(true, 'no earlier successful deployment to compare against')
if (git(['cat-file', '-e', `${previous}^{commit}`], 'ignore') !== 0) {
  decide(true, `last deployed commit ${previous} is not in the clone`)
}

const status = git(['diff', '--quiet', previous, 'HEAD', '--', ...PATHS])
if (status === 0) decide(false, `nothing the site uses changed since ${previous}`)
decide(true, status === 1 ? `the site changed since ${previous}` : 'git diff failed')

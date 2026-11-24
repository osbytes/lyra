// Re-runs a recorded session's kept audio through Lyra's speaker pipelines, to debug a session
// that came out mislabeled:
//
//   pnpm replay:session 2026-11-23_15-44-01.txt                      # a session in ~/.lyra
//   pnpm replay:session C:\notes\.sessions\2026-11-23_15-44-01.txt   # or its folder
//   pnpm replay:session <session> --pipelines live,stream,offline --reference ref.json
//
// For each pipeline (live: what the app runs; stream: track labels before relabel; offline:
// diarize then transcribe) it prints who spoke each line and how long each speaker talked,
// next to what the session got when it was recorded. With --reference (the run-eval format:
// { segments: [{ speaker, start, end, text }] }) each run is also scored. Hypotheses go to
// eval-data/replays/<session>/. The session is read, never
// changed; nothing leaves the machine.
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { basename, isAbsolute, join, resolve } = require('node:path')
const { score } = require('./eval/metrics.cjs')

const root = join(__dirname, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function sessionDir(target) {
  if (isAbsolute(target) || existsSync(target)) return resolve(target)
  return join(process.env.LYRA_NOTES_DIR ?? join(homedir(), '.lyra'), '.sessions', target)
}

const clock = (seconds) => {
  const s = Math.floor(seconds)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function summarize(label, segments) {
  const talk = new Map()
  for (const { speaker, start, end } of segments) talk.set(speaker, (talk.get(speaker) ?? 0) + end - start)
  const voices = [...talk.entries()].map(([speaker, seconds]) => `${speaker} ${seconds.toFixed(0)}s`).join(', ')
  process.stdout.write(`\n== ${label}: ${talk.size} speaker(s): ${voices}\n`)
  for (const { speaker, start, text } of segments) {
    process.stdout.write(`  [${clock(start)}] ${String(speaker).padEnd(4)} ${text.slice(0, 100)}\n`)
  }
}

function main() {
  const target = process.argv[2]
  if (!target || target.startsWith('--')) {
    console.error('usage: pnpm replay:session <session id or folder> [--pipelines live,stream,offline] [--reference ref.json]')
    process.exit(1)
  }
  const dir = sessionDir(target)
  const mic = join(dir, 'audio', 'mic.wav')
  const system = join(dir, 'audio', 'system.wav')
  if (!existsSync(mic)) throw new Error(`no kept audio at ${mic} (audio may have passed its retention)`)
  const referencePath = arg('reference', null)
  const reference = referencePath ? JSON.parse(readFileSync(referencePath, 'utf8')) : null
  const outDir = join(process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data'), 'replays', basename(dir))
  mkdirSync(outDir, { recursive: true })

  // What the session got when it was recorded: the newest pass's segments.
  const live = join(dir, 'raw', 'live.json')
  if (existsSync(live)) {
    const recorded = JSON.parse(readFileSync(live, 'utf8'))
    summarize(
      'as recorded (live pass)',
      recorded.segments.map((s) => ({ speaker: s.cluster ?? '?', start: s.start, end: s.end, text: s.words.map((w) => w.text).join('').trim() }))
    )
  }

  const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'ignore', shell: true })
  if (build.status !== 0) throw new Error('build failed; run `pnpm exec electron-vite build` to see why')
  for (const pipeline of arg('pipelines', 'live,offline').split(',').filter(Boolean)) {
    const output = join(outDir, `${pipeline}.hyp.json`)
    const started = Date.now()
    const args = [
      join(__dirname, 'run-meeting-smoke.cjs'),
      mic,
      ...(existsSync(system) ? [system] : []),
      '--output',
      output,
      ...(pipeline === 'offline' ? ['--offline'] : []),
      ...(pipeline === 'stream' ? ['--no-relabel'] : [])
    ]
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit']
    })
    if (result.status !== 0 || !existsSync(output)) throw new Error(`${pipeline} replay failed (exit ${result.status})`)
    const hyp = JSON.parse(readFileSync(output, 'utf8'))
    summarize(`${pipeline} (${((Date.now() - started) / 1000).toFixed(0)} s)`, hyp.segments)
    if (reference) {
      const { wer, cpWer, der, hypSpeakers, refSpeakers } = score(reference, hyp)
      const pct = (value) => `${(value * 100).toFixed(1)}%`
      process.stdout.write(`  WER ${pct(wer.rate)}  cpWER ${pct(cpWer.rate)}  DER ${pct(der.rate)}  speakers ${hypSpeakers}/${refSpeakers}\n`)
    }
  }
  writeFileSync(join(outDir, 'source.txt'), `${dir}\n`)
  process.stdout.write(`\nreplay: hypotheses in ${outDir}\n`)
}

try {
  main()
} catch (error) {
  console.error('replay failed:', error.message)
  process.exit(1)
}

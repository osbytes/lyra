// Scores Lyra's meeting pipeline (diarization + Whisper) on labeled multi-speaker audio.
//
//   pnpm eval:calls                                 # synthetic call scenarios (bleed, clipping, quick turns, crosstalk)
//   pnpm eval:calls --scenarios call-speakers,call-quick-turns
//   pnpm eval:sessions                              # real voices laid out as room, hybrid and call sessions
//   pnpm eval:sessions --sessions room-2-desk,hybrid-2+1 --seeds 3   # three draws of each
//   LYRA_SESSIONS_CORPUS=mini pnpm eval:sessions                     # the 126 MB corpus instead
//   pnpm eval:ami                                   # ES2004a, IS1009a, TS3003a; first 10 min; far-field mic
//   pnpm eval:ami --meetings ES2004a --minutes 5 --mic Mix-Headset
//   pnpm eval:ami --minutes 0                       # whole meetings (slow)
//   pnpm eval:local                                 # your own recordings (scripts/eval/local.cjs)
//   node scripts/run-eval.cjs --score ref.json hyp.json   # score any two transcripts
//   --check                   compare with the stored baseline for this suite, pipeline and
//                             machine (scripts/eval/baselines/; eval-data/ for local cases) and
//                             exit 1 if a rate rose past the tolerance (scripts/eval/baseline.cjs)
//   --update-baseline         store this run as that baseline: only for a change you mean
//   --enroll                  sessions: save the first person's voice (enroll.wav) before replaying
//   --asr whisper|parakeet    live and stream: the speech model (whisper, the default, is the app's)
//   --no-context              live and stream: Whisper without a track's earlier text as its prompt
//   --quick                   a few minutes, not an hour: a fixed subset covering each kind of
//                             trouble (speaker echo, quick turns, reverb, similar voices, music,
//                             hybrid), two at a time. For direction while working; full runs for
//                             the numbers in docs/EVALS.md
//   --jobs <n>                items to run at once (default 1, or 2 with --quick); each loads
//                             Whisper, about 1 GB of GPU memory
//   --pipeline capture        live, but the mic track played as a fake microphone through the
//                             window's real capture path (getUserMedia, the AudioContext), in real
//                             time. Loopback can't be faked, so the system track is left out: use
//                             it on room sessions (`--sessions room-2-desk,room-2-fan`)
//   --pipeline live|stream|offline   live (default) replays the audio as a recording, as the app
//                             runs it: speakers settled every half minute while it records, then
//                             relabeling once it stops; stream is the lines as they stood at the
//                             stop (the newest not labeled yet); offline is the
//                             diarize-then-transcribe pipeline
//
// Prints WER, cpWER (words given to the wrong speaker count as errors) and DER per item, with
// `relabeled`: the share of the speaker labels shown while recording that the pass after the stop
// changed (live pipeline; what a reader watching the transcript saw corrected), and
// // writes references, hypotheses and results.json under eval-data/results/<time>/. Data goes to
// eval-data/ (gitignored); set LYRA_EVAL_DATA to keep it elsewhere. Set LYRA_MODELS_DIR to reuse
// downloaded models, as for smoke:meeting.
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const ami = require('./eval/ami.cjs')
const { compare, summarize } = require('./eval/baseline.cjs')
const calls = require('./eval/calls.cjs')
const local = require('./eval/local.cjs')
const sessions = require('./eval/sessions.cjs')
const { score } = require('./eval/metrics.cjs')

const root = join(__dirname, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const list = (value) => value.split(',').filter(Boolean)
const quick = process.argv.includes('--quick')
/** One of each kind of trouble the full suites cover, chosen to finish in minutes. */
const QUICK = {
  calls: ['call-speakers', 'call-quick-turns', 'call-similar-voices', 'room-far-field'],
  sessions: ['room-2-desk', 'room-2-quick', 'room-2-music', 'hybrid-2+1', 'call-1+1-quick']
}
const jobs = Math.max(1, Number(arg('jobs', quick ? '2' : '1')) || 1)
const pipeline = arg('pipeline', 'live')
/** Sessions only: save the owner's enroll.wav as a voice first, as a user who set up People. */
const enroll = process.argv.includes('--enroll')
const asr = arg('asr', 'whisper')
const noContext = process.argv.includes('--no-context')
const pct = (value) => `${(value * 100).toFixed(1)}%`.padStart(7)

function report(id, result) {
  const { wer, cpWer, der } = result
  process.stdout.write(
    `${id.padEnd(22)} WER ${pct(wer.rate)}  cpWER ${pct(cpWer.rate)}  DER ${pct(der.rate)}` +
      ` (miss ${pct(der.missed)} fa ${pct(der.falseAlarm)} conf ${pct(der.confusion)})` +
      `  speakers ${result.hypSpeakers}/${result.refSpeakers}` +
      `${relabeled(result.labels) === null ? '' : `  relabeled ${pct(relabeled(result.labels)).trim()}`}\n`
  )
}

/** The share of the labels shown at the stop that the last pass changed; null when none were. */
function relabeled(labels) {
  return labels && labels.labeledAtStop > 0 ? labels.changedAtStop / labels.labeledAtStop : null
}

/**
 * Where this suite's baseline is kept. In the repo for the generated suites, by machine: Whisper
 * hears a little differently on each backend. Beside the cases for your own recordings, whose
 * names stay out of the repo.
 */
function baselinePath(dataset, dataDir, name) {
  const file = `${name}-${process.platform}-${process.arch}.json`
  return dataset === 'local' ? join(local.localDir(dataDir), 'baselines', file) : join(__dirname, 'eval', 'baselines', file)
}

/** Prints how the run compares with its baseline; false when it got worse. */
function checkBaseline(path, run) {
  if (!existsSync(path)) {
    process.stdout.write(`eval: no baseline at ${path}; make one with --update-baseline\n`)
    return false
  }
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  const current = summarize(run)
  const { regressions, missing, ok } = compare(baseline, current)
  const delta = (rate) => {
    const before = baseline.overall[rate]
    const after = current.overall[rate]
    return before === undefined || after === undefined ? '' : `  ${rate} ${pct(before).trim()} → ${pct(after).trim()}`
  }
  process.stdout.write(`baseline:${['wer', 'cpWer', 'der', 'relabeled'].map(delta).join('')}\n`)
  for (const { id, rate, before, after } of regressions) {
    process.stdout.write(`  worse: ${id} ${rate} ${pct(before).trim()} → ${pct(after).trim()}\n`)
  }
  for (const id of missing) process.stdout.write(`  missing: ${id} is in the baseline and did not run\n`)
  process.stdout.write(ok ? 'eval: no worse than the baseline\n' : 'eval: worse than the baseline\n')
  return ok
}

function scoreFiles(refPath, hypPath) {
  const result = score(JSON.parse(readFileSync(refPath, 'utf8')), JSON.parse(readFileSync(hypPath, 'utf8')))
  report('score', result)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

/** Runs the real pipeline through the smoke:meeting entry point and resolves its transcript. */
function runLyra(item, output) {
  const args = [
    join(__dirname, 'run-meeting-smoke.cjs'),
    item.wav,
    ...(item.system && pipeline !== 'capture' ? [item.system] : []),
    '--output',
    output,
    ...(pipeline === 'offline' ? ['--offline'] : []),
    ...(pipeline === 'stream' ? ['--no-relabel'] : []),
    ...(pipeline === 'capture' ? ['--capture'] : []),
    ...(enroll && item.enroll ? ['--enroll', item.enroll] : []),
    ...(asr !== 'whisper' ? ['--asr', asr] : []),
    ...(noContext ? ['--no-context'] : [])
  ]
  // With several running at once their logs would only interleave, so they go nowhere.
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'ignore', jobs > 1 ? 'ignore' : 'inherit'] })
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('exit', (status) => {
      if (status !== 0 || !existsSync(output)) reject(new Error(`pipeline failed on ${item.wav} (exit ${status})`))
      else resolvePromise(JSON.parse(readFileSync(output, 'utf8')))
    })
  })
}

/** The items to score for --dataset, each prepared lazily so one bad download doesn't stop the rest. */
function plan(dataset, dataDir) {
  if (dataset === 'calls') {
    const names = list(arg('scenarios', (quick ? QUICK.calls : Object.keys(calls.SCENARIOS)).join(',')))
    return { options: { scenarios: names }, items: names.map((name) => ({ name, prepare: async () => calls.prepare(dataDir, name) })) }
  }
  if (dataset === 'sessions') {
    const names = list(arg('sessions', (quick ? QUICK.sessions : sessions.DEFAULT_SESSIONS).join(',')))
    const seeds = Number(arg('seeds', '1'))
    const ids = sessions.sessionIds(names, seeds)
    const corpus = process.env.LYRA_SESSIONS_CORPUS ?? 'librispeech'
    return {
      label: `sessions-${corpus}`,
      options: { sessions: names, seeds, corpus, version: sessions.DATASET_VERSION },
      items: ids.map((name) => ({ name, prepare: () => sessions.prepare(dataDir, name) }))
    }
  }
  if (dataset === 'local') {
    const names = list(arg('cases', local.names(dataDir).join(',')))
    if (names.length === 0) throw new Error('no local cases yet; add one with `node scripts/eval/local.cjs add <session>`')
    return { options: { cases: names.length }, items: names.map((name) => ({ name, prepare: async () => local.prepare(dataDir, name) })) }
  }
  if (dataset === 'ami') {
    const meetings = list(arg('meetings', ami.DEFAULT_MEETINGS.join(',')))
    const minutes = Number(arg('minutes', '10'))
    const mic = arg('mic', ami.MICS[0])
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--minutes must be a number ≥ 0')
    return {
      options: { meetings, minutes, mic },
      items: meetings.map((meeting) => ({ name: meeting, prepare: () => ami.prepare(dataDir, meeting, { mic, minutes }) }))
    }
  }
  throw new Error(`unknown --dataset ${dataset}; use calls, sessions, local or ami`)
}

async function main() {
  const scoreIndex = process.argv.indexOf('--score')
  if (scoreIndex !== -1) return scoreFiles(process.argv[scoreIndex + 1], process.argv[scoreIndex + 2])

  const dataset = arg('dataset', 'calls')
  const dataDir = resolve(process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data'))
  const { label, options, items } = plan(dataset, dataDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (!['live', 'stream', 'offline', 'capture'].includes(pipeline)) {
    throw new Error('--pipeline must be live, stream, offline or capture')
  }
  const outDir = join(dataDir, 'results', `${label ?? dataset}${quick ? '-quick' : ''}-${pipeline}-${stamp}`)
  mkdirSync(outDir, { recursive: true })

  // One build up front; run-meeting-smoke.cjs launches the built app.
  const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'ignore', shell: true })
  if (build.status !== 0) throw new Error('build failed; run `pnpm exec electron-vite build` to see why')

  const results = []
  const failures = []
  const save = () => {
    // Pooled: total errors over total reference words (or time), not a mean of per-item rates.
    const sum = (pick) => results.reduce((total, r) => total + pick(r), 0)
    const words = sum((r) => r.wer.words)
    const derTime = sum((r) => r.der.scoredSeconds)
    const overall = {
      wer: words ? sum((r) => r.wer.errors) / words : 0,
      cpWer: words ? sum((r) => r.cpWer.errors) / sum((r) => r.cpWer.words) : 0,
      der: derTime ? sum((r) => r.der.rate * r.der.scoredSeconds) / derTime : 0
    }
    const labeled = sum((r) => r.labels?.labeledAtStop ?? 0)
    if (labeled > 0) overall.relabeled = sum((r) => r.labels?.changedAtStop ?? 0) / labeled
    const run = { dataset, pipeline, ...options, overall, results, failures }
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(run, null, 2))
    return run
  }

  const runOne = async ({ name, prepare }) => {
    try {
      const item = await prepare()
      writeFileSync(join(outDir, `${item.id}.ref.json`), JSON.stringify(item.reference, null, 2))
      process.stdout.write(`eval: ${item.id} (${(item.seconds / 60).toFixed(1)} min) running…\n`)
      const hyp = await runLyra(item, join(outDir, `${item.id}.hyp.json`))
      const result = score(item.reference, hyp)
      report(item.id, { ...result, labels: hyp.labels })
      results.push({ id: item.id, audioSeconds: item.seconds, pipelineSeconds: hyp.seconds, labels: hyp.labels, ...result })
    } catch (error) {
      process.stdout.write(`eval: ${name} failed: ${error.message}\n`)
      failures.push({ id: name, error: error.message })
    }
    save()
  }
  // Up to `jobs` replays at once; each takes the next item when it finishes.
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await runOne(next)
    })
  )

  const run = save()
  const { overall } = run
  if (results.length > 0) {
    process.stdout.write(
      `${'overall'.padEnd(22)} WER ${pct(overall.wer)}  cpWER ${pct(overall.cpWer)}  DER ${pct(overall.der)}` +
        `${overall.relabeled === undefined ? '' : `  relabeled ${pct(overall.relabeled).trim()}`}\n`
    )
  }
  process.stdout.write(`eval: results in ${outDir}\n`)
  if (failures.length > 0) process.exit(1)
  const baseline = baselinePath(dataset, dataDir, `${label ?? dataset}${quick ? '-quick' : ''}-${pipeline}`)
  if (process.argv.includes('--update-baseline')) {
    mkdirSync(join(baseline, '..'), { recursive: true })
    writeFileSync(baseline, `${JSON.stringify(summarize(run), null, 2)}\n`)
    process.stdout.write(`eval: baseline saved to ${baseline}\n`)
  } else if (process.argv.includes('--check') && !checkBaseline(baseline, run)) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('eval failed:', error.message)
  process.exit(1)
})

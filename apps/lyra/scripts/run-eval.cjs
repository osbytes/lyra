// Scores Lyra's meeting pipeline (diarization + Whisper) on labeled multi-speaker audio.
//
//   pnpm eval:calls                                 # synthetic call scenarios (bleed, clipping, quick turns, crosstalk)
//   pnpm eval:calls --scenarios call-speakers,call-quick-turns
//   pnpm eval:ami                                   # ES2004a, IS1009a, TS3003a; first 10 min; far-field mic
//   pnpm eval:ami --meetings ES2004a --minutes 5 --mic Mix-Headset
//   pnpm eval:ami --minutes 0                       # whole meetings (slow)
//   node scripts/run-eval.cjs --score ref.json hyp.json   # score any two transcripts
//   --pipeline live|stream|offline   live (default) replays the audio as a recording, as the app
//                             runs it: live identification, then relabeling once it stops; stream
//                             is live identification alone; offline is the diarize-then-transcribe
//                             pipeline
//
// Prints WER, cpWER (words given to the wrong speaker count as errors) and DER per item, and
// writes references, hypotheses and results.json under eval-data/results/<time>/. Data goes to
// eval-data/ (gitignored); set LYRA_EVAL_DATA to keep it elsewhere. Set LYRA_MODELS_DIR to reuse
// downloaded models, as for smoke:meeting.
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const ami = require('./eval/ami.cjs')
const calls = require('./eval/calls.cjs')
const { score } = require('./eval/metrics.cjs')

const root = join(__dirname, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const list = (value) => value.split(',').filter(Boolean)
const pipeline = arg('pipeline', 'live')
const pct = (value) => `${(value * 100).toFixed(1)}%`.padStart(7)

function report(id, result) {
  const { wer, cpWer, der } = result
  process.stdout.write(
    `${id.padEnd(22)} WER ${pct(wer.rate)}  cpWER ${pct(cpWer.rate)}  DER ${pct(der.rate)}` +
      ` (miss ${pct(der.missed)} fa ${pct(der.falseAlarm)} conf ${pct(der.confusion)})` +
      `  speakers ${result.hypSpeakers}/${result.refSpeakers}\n`
  )
}

function scoreFiles(refPath, hypPath) {
  const result = score(JSON.parse(readFileSync(refPath, 'utf8')), JSON.parse(readFileSync(hypPath, 'utf8')))
  report('score', result)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

/** Runs the real pipeline through the smoke:meeting entry point and returns its transcript. */
function runLyra(item, output) {
  const args = [
    join(__dirname, 'run-meeting-smoke.cjs'),
    item.wav,
    ...(item.system ? [item.system] : []),
    '--output',
    output,
    ...(pipeline === 'offline' ? ['--offline'] : []),
    ...(pipeline === 'stream' ? ['--no-relabel'] : [])
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit']
  })
  if (result.status !== 0 || !existsSync(output)) throw new Error(`pipeline failed on ${item.wav} (exit ${result.status})`)
  return JSON.parse(readFileSync(output, 'utf8'))
}

/** The items to score for --dataset, each prepared lazily so one bad download doesn't stop the rest. */
function plan(dataset, dataDir) {
  if (dataset === 'calls') {
    const names = list(arg('scenarios', Object.keys(calls.SCENARIOS).join(',')))
    return { options: { scenarios: names }, items: names.map((name) => ({ name, prepare: async () => calls.prepare(dataDir, name) })) }
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
  throw new Error(`unknown --dataset ${dataset}; use calls or ami`)
}

async function main() {
  const scoreIndex = process.argv.indexOf('--score')
  if (scoreIndex !== -1) return scoreFiles(process.argv[scoreIndex + 1], process.argv[scoreIndex + 2])

  const dataset = arg('dataset', 'calls')
  const dataDir = resolve(process.env.LYRA_EVAL_DATA ?? join(root, 'eval-data'))
  const { options, items } = plan(dataset, dataDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (!['live', 'stream', 'offline'].includes(pipeline)) throw new Error('--pipeline must be live, stream or offline')
  const outDir = join(dataDir, 'results', `${dataset}-${pipeline}-${stamp}`)
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
    writeFileSync(join(outDir, 'results.json'), JSON.stringify({ dataset, pipeline, ...options, overall, results, failures }, null, 2))
    return overall
  }

  for (const { name, prepare } of items) {
    try {
      const item = await prepare()
      writeFileSync(join(outDir, `${item.id}.ref.json`), JSON.stringify(item.reference, null, 2))
      process.stdout.write(`eval: ${item.id} (${(item.seconds / 60).toFixed(1)} min) running…\n`)
      const hyp = runLyra(item, join(outDir, `${item.id}.hyp.json`))
      const result = score(item.reference, hyp)
      report(item.id, result)
      results.push({ id: item.id, audioSeconds: item.seconds, pipelineSeconds: hyp.seconds, ...result })
    } catch (error) {
      process.stdout.write(`eval: ${name} failed: ${error.message}\n`)
      failures.push({ id: name, error: error.message })
    }
    save()
  }

  const overall = save()
  if (results.length > 0) {
    process.stdout.write(`${'overall'.padEnd(22)} WER ${pct(overall.wer)}  cpWER ${pct(overall.cpWer)}  DER ${pct(overall.der)}\n`)
  }
  process.stdout.write(`eval: results in ${outDir}\n`)
  if (failures.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error('eval failed:', error.message)
  process.exit(1)
})

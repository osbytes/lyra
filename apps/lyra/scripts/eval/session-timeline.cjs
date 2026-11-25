// A real session's timeline with nothing personal in it, to rebuild as an eval case
// (`script` in sessions.cjs) when it came out wrong:
//
//   node scripts/eval/session-timeline.cjs <session id or folder>
//
// From the session's raw/live.json it prints each stretch of speech: the track it was heard on,
// when, how long, and how many words, and per-second levels of the kept audio. It prints no words
// and copies no audio: those are the people's, and stay on this machine. Turns on one track are
// joined across short gaps; who said which is for the investigator to decide (the replay, the
// voiceprint scores and what the user said), so each track starts as one person.
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { isAbsolute, join, resolve } = require('node:path')
const { readWav, RATE } = require('./wav.cjs')

/** Speech on one track closer than this joins one turn. */
const JOIN_GAP_SECONDS = 1.5

function sessionDir(target) {
  if (isAbsolute(target) || existsSync(target)) return resolve(target)
  return join(process.env.LYRA_NOTES_DIR ?? join(homedir(), '.lyra'), '.sessions', target)
}

function db(samples, from, to) {
  let sum = 0
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2
  return 10 * Math.log10(sum / Math.max(1, to - from) + 1e-12)
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/eval/session-timeline.cjs <session id or folder>')
    process.exit(1)
  }
  const dir = sessionDir(target)
  const live = JSON.parse(readFileSync(join(dir, 'raw', 'live.json'), 'utf8'))
  const turns = []
  const chunks = [...live.segments].sort((a, b) => a.start - b.start)
  for (const chunk of chunks) {
    const track = chunk.track ?? 'mix'
    const words = Array.isArray(chunk.words) ? chunk.words.length : 0
    const last = turns.findLast((turn) => turn.track === track)
    if (last && chunk.start - last.end <= JOIN_GAP_SECONDS) {
      last.end = Math.max(last.end, chunk.end)
      last.words += words
    } else {
      turns.push({ track, start: chunk.start, end: chunk.end, words })
    }
  }
  turns.sort((a, b) => a.start - b.start)
  const people = [...new Set(turns.map((turn) => turn.track))]
  process.stdout.write(`people (one per track to start): ${people.map((track, i) => `${i} = ${track}`).join(', ')}\n\n`)
  process.stdout.write('track    start   seconds  words\n')
  for (const turn of turns) {
    process.stdout.write(
      `${turn.track.padEnd(7)} ${turn.start.toFixed(1).padStart(6)} ${(turn.end - turn.start).toFixed(1).padStart(8)} ${String(turn.words).padStart(6)}\n`
    )
  }
  process.stdout.write('\nscript: [\n')
  for (const turn of turns) {
    process.stdout.write(`  [${people.indexOf(turn.track)}, ${turn.start.toFixed(1)}, ${(turn.end - turn.start).toFixed(1)}],\n`)
  }
  process.stdout.write(']\n')

  // Levels say how loud each track was (a quiet mic, speaker bleed), which the case's seats,
  // `bleed` and `fan` should echo.
  const mic = join(dir, 'audio', 'mic.wav')
  if (!existsSync(mic)) return
  const system = join(dir, 'audio', 'system.wav')
  const tracks = [['mic', readWav(mic)], ...(existsSync(system) ? [['system', readWav(system)]] : [])]
  process.stdout.write('\nlevels, dB per 5 s:\n')
  for (const [name, samples] of tracks) {
    const levels = []
    for (let at = 0; at < samples.length; at += 5 * RATE) levels.push(db(samples, at, Math.min(samples.length, at + 5 * RATE)).toFixed(0))
    process.stdout.write(`${name.padEnd(7)} ${levels.join(' ')}\n`)
  }
}

main()

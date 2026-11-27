// A private eval suite from your own recordings: real rooms, real microphones and real voices,
// which no generated session reproduces. Cases live in <eval-data>/local/<name>/ (gitignored)
// and never leave this machine or enter the repo: not the audio, not the text, not the names.
//
//   node scripts/eval/local.cjs add <session id or folder> [--name desk-two-people]
//   pnpm eval:local                      # replay every case and score it
//   pnpm eval:local --check              # …and fail if it got worse than the saved baseline
//
// `add` copies the session's kept audio and writes its transcript as it stands now, speakers and
// text, as the reference. So first make the session right in the app (move lines to the right
// speaker, fix words); the reference is only as good as that. Whisper wrote the text and will
// write it again, so WER says little here; cpWER and DER say whether each line still goes to
// the right person. The session is read, never changed.
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { basename, isAbsolute, join, resolve } = require('node:path')

const localDir = (dataDir) => join(dataDir, 'local')

/** A session's lines as its document (`doc.json`) has them now. */
function transcriptOf(docPath) {
  if (!existsSync(docPath)) {
    throw new Error(`no ${basename(docPath)}: open the session in Lyra once, so it moves to the current format`)
  }
  const doc = JSON.parse(readFileSync(docPath, 'utf8'))
  return (Array.isArray(doc.transcript) ? doc.transcript : []).map((entry) => ({
    speaker: typeof entry.cluster === 'string' ? entry.cluster : null,
    start: Number(entry.start) || 0,
    end: Number(entry.end) || 0,
    text: typeof entry.text === 'string' ? entry.text : ''
  }))
}

function add(dataDir, target, name) {
  const dir =
    isAbsolute(target) || existsSync(target)
      ? resolve(target)
      : join(process.env.LYRA_NOTES_DIR ?? join(homedir(), '.lyra'), '.sessions', target)
  const mic = join(dir, 'audio', 'mic.wav')
  if (!existsSync(mic)) throw new Error(`no kept audio at ${mic} (audio may have passed its retention)`)
  const segments = transcriptOf(join(dir, 'doc.json'))
  const unlabeled = segments.filter((segment) => segment.speaker === null).length
  if (segments.length === 0) throw new Error('the session has no transcript')
  if (unlabeled > 0) throw new Error(`${unlabeled} line(s) have no speaker yet; let Lyra finish, or give them one in the app`)
  const out = join(localDir(dataDir), name ?? basename(dir).replace(/\.(txt|md)$/, ''))
  mkdirSync(out, { recursive: true })
  copyFileSync(mic, join(out, 'mic.wav'))
  const system = join(dir, 'audio', 'system.wav')
  if (existsSync(system)) copyFileSync(system, join(out, 'system.wav'))
  const seconds = Math.max(0, ...segments.map((segment) => segment.end))
  writeFileSync(join(out, 'reference.json'), JSON.stringify({ seconds, segments }, null, 2))
  const speakers = new Set(segments.map((segment) => segment.speaker)).size
  process.stdout.write(`local case ${basename(out)}: ${segments.length} lines, ${speakers} speaker(s), ${(seconds / 60).toFixed(1)} min\n`)
}

/** The cases on disk, by name. */
function names(dataDir) {
  const dir = localDir(dataDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'reference.json'))).sort()
}

function prepare(dataDir, name) {
  const dir = join(localDir(dataDir), name)
  const reference = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'))
  const system = join(dir, 'system.wav')
  return { id: name, wav: join(dir, 'mic.wav'), system: existsSync(system) ? system : null, seconds: reference.seconds, reference }
}

module.exports = { localDir, names, prepare }

if (require.main === module) {
  const [command, target] = process.argv.slice(2)
  const nameAt = process.argv.indexOf('--name')
  try {
    if (command !== 'add' || !target) throw new Error('usage: node scripts/eval/local.cjs add <session id or folder> [--name <name>]')
    const dataDir = resolve(process.env.LYRA_EVAL_DATA ?? join(__dirname, '..', '..', 'eval-data'))
    add(dataDir, target, nameAt === -1 ? undefined : process.argv[nameAt + 1])
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

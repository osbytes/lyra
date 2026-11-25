// Regenerates the word lists Lyra takes from other projects instead of writing them by hand:
//
//   pnpm word-lists           # fetch the pinned sources and rewrite the JSON files
//   pnpm word-lists --check   # fail if the files don't match the sources (needs the network)
//
// - src/main/data/hallucinations.json: what Whisper writes when it hears no speech, from two
//   published lists. whisper.ts drops a chunk whose whole text is one of these.
// - src/shared/data/whisperLanguages.json: the languages Whisper can transcribe, from its own
//   tokenizer, for the Language setting.
//
// Every source is pinned to a revision and checked against its sha256, as models are
// (src/main/models.ts), so the lists only change when this file does. To update one, change its
// revision and hash here, run this, and say in THIRD_PARTY.md what changed.
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

const HALLUCINATION_SOURCES = [
  {
    name: 'Bag of Hallucinations (Barański et al., ICASSP 2025)',
    url: 'https://raw.githubusercontent.com/DSP-AGH/ICASSP2025_Whisper_Hallucination/c6d6db174d070e1fa4589f1a29bbec69e9ed0de9/BoH.csv',
    sha256: '11dab71deebee47bdf11e10b3f8c293fc529c9287d42d46fc3d608d33262c1c2',
    license: 'MIT',
    phrase: 'prediction',
    count: 'number of occurrences in noise',
    // Whisper's output on 20+ noise clips. Lower counts are mostly one-off sentences, which are
    // also things people say ("I'm going to go get some water").
    minCount: 20
  },
  {
    name: 'whisper-hallucinations (Sacha Arbonel, 2025)',
    url: 'https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations/resolve/05c3a97e8906426979fb7c4f64004af44104810c/phrases.csv',
    sha256: '99c2896f655c8d05601fdbd363d58381dc8fa21e2e97891fa38a593c10b036eb',
    license: 'MIT',
    phrase: 'phrase',
    count: 'count',
    // Multilingual and smaller: a phrase seen once is noise in the list itself.
    minCount: 2
  }
]

const LANGUAGE_SOURCE = {
  name: 'openai/whisper tokenizer',
  url: 'https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/whisper/tokenizer.py',
  sha256: '3b48e361a7e95b4ec0356ca6d72bba635778aa10269153136ee7bc34cae30b85',
  license: 'MIT'
}

async function fetchPinned(source) {
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== source.sha256) throw new Error(`${source.url}: sha256 ${hash}, expected ${source.sha256}`)
  return bytes.toString('utf8')
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header = [], ...body] = rows.filter((r) => r.some((cell) => cell.trim()))
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name.trim(), cells[i] ?? ''])))
}

function hallucinationPhrases(source, csv) {
  const kept = []
  for (const row of parseCsv(csv)) {
    const phrase = (row[source.phrase] ?? '').trim()
    const count = Number(row[source.count])
    // U+FFFD: the list's own encoding damage ("merci d'avoir regard� cette vid�o").
    if (!phrase || phrase.includes('�') || !(count >= source.minCount)) continue
    kept.push(phrase)
  }
  return kept
}

function whisperLanguages(python) {
  const block = /LANGUAGES = \{([\s\S]*?)\n\}/.exec(python)
  if (!block?.[1]) throw new Error('LANGUAGES not found in the Whisper tokenizer')
  const languages = [...block[1].matchAll(/"([a-z]{2,3})":\s*"([^"]+)"/g)].map(([, code, name]) => ({
    code,
    name: name.replace(/\b\w/g, (ch) => ch.toUpperCase())
  }))
  if (languages.length < 90) throw new Error(`only ${languages.length} languages parsed`)
  return languages
}

function describe(source, extra) {
  return { name: source.name, url: source.url, sha256: source.sha256, license: source.license, ...extra }
}

async function build() {
  const sources = []
  const phrases = new Set()
  for (const source of HALLUCINATION_SOURCES) {
    const kept = hallucinationPhrases(source, await fetchPinned(source))
    for (const phrase of kept) phrases.add(phrase)
    sources.push(describe(source, { minCount: source.minCount, phrases: kept.length }))
  }
  const hallucinations = {
    generatedBy: 'scripts/update-word-lists.cjs',
    sources,
    phrases: [...phrases].sort()
  }
  const languages = {
    generatedBy: 'scripts/update-word-lists.cjs',
    source: describe(LANGUAGE_SOURCE, {}),
    languages: whisperLanguages(await fetchPinned(LANGUAGE_SOURCE))
  }
  return [
    [join(root, 'src/main/data/hallucinations.json'), hallucinations],
    [join(root, 'src/shared/data/whisperLanguages.json'), languages]
  ]
}

async function main() {
  const check = process.argv.includes('--check')
  let stale = false
  for (const [path, value] of await build()) {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (!check) {
      writeFileSync(path, text, 'utf8')
      process.stdout.write(`wrote ${path}\n`)
      continue
    }
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      // Missing counts as stale.
    }
    if (current !== text) {
      stale = true
      process.stderr.write(`${path} is stale: run pnpm word-lists\n`)
    }
  }
  if (stale) process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`word-lists: ${error.message}\n`)
  process.exit(1)
})

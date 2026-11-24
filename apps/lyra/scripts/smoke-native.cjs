const { app } = require('electron')
const { createRequire } = require('module')
const { join } = require('path')
const { arch, platform } = require('os')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('fs')
const { tmpdir } = require('os')

function addonFolder() {
  const os = platform()
  const cpu = arch()
  if (os === 'darwin' && cpu === 'arm64') return 'mac-arm64'
  if (os === 'darwin') return 'mac-x64'
  if (os === 'win32') return 'win32-x64'
  if (os === 'linux' && cpu === 'arm64') return 'linux-arm64'
  return 'linux-x64'
}

// The search index (src/main/searchIndex): libSQL's prebuilt binary loads, FTS5 and vectors
// work, and a binary parameter binds. Binding a Buffer through libsql's sync API aborts the
// process (docs/SEARCH-INDEX.md), so this goes through @libsql/client, as the app does.
async function checkLibsql() {
  const { createClient } = require('@libsql/client')
  const db = createClient({ url: ':memory:' })
  await db.execute("CREATE VIRTUAL TABLE f USING fts5(text, tokenize='porter unicode61')")
  await db.execute({ sql: 'INSERT INTO f VALUES (?)', args: ['the budgets were discussed'] })
  const words = await db.execute("SELECT count(*) AS n FROM f WHERE f MATCH 'budget'")
  if (words.rows[0]?.n !== 1) throw new Error('FTS5 stemming did not match')
  await db.execute('CREATE TABLE v (e F32_BLOB(3))')
  await db.execute({ sql: 'INSERT INTO v VALUES (?)', args: [new Float32Array([1, 0, 0]).buffer] })
  const near = await db.execute({
    sql: 'SELECT vector_distance_cos(e, ?) AS d FROM v',
    args: [new Float32Array([1, 0, 0]).buffer]
  })
  if (near.rows[0]?.d !== 0) throw new Error('vector distance was wrong')
  db.close()
}

app.whenReady().then(async () => {
  try {
    await checkLibsql()
    console.log('ok: libsql loaded with FTS5 and vectors')
    const req = createRequire(__filename)
    const pkgRoot = join(req.resolve('@kutalia/whisper-node-addon/package.json'), '..')
    const addonPath = join(pkgRoot, 'dist', addonFolder(), 'whisper.node')
    const native = req(addonPath)
    if (typeof native.whisper !== 'function') {
      throw new Error('whisper.node did not export whisper()')
    }

    const dir = join(tmpdir(), `voice-pages-smoke-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'page.md')
    const body = `---\nid: smoke\ntitle: "Hello"\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nTalked this out.`
    writeFileSync(file, body, 'utf8')
    const roundTrip = readFileSync(file, 'utf8')
    if (!roundTrip.includes('Talked this out')) {
      throw new Error('markdown round-trip failed')
    }
    rmSync(dir, { recursive: true, force: true })

    console.log('ok: native whisper addon loaded for', addonFolder())
    console.log('ok: page markdown round-trip')
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})

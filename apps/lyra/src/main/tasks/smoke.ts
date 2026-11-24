/** `lyra smoke`: main-process checks, then the IPC bridge exercised from the renderer. */
import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesDir } from '../pages'
import {
  applySessionUpdate,
  closeSessionFor,
  createSession as createPage,
  deleteSession as deletePage,
  flushAllSessions,
  getSessionPage as getPage,
  listSessions as listPages,
  editSession,
  openSessionFor,
  readSession,
  readSessionFromDisk,
  sessionAudioDir,
  sessionRawDir,
  updateManifest,
  saveSessionPage as savePage,
  setAutoTitle,
  sidecarPath
} from '../sessionStore'
import * as Y from 'yjs'
import {
  ORIGIN_TRANSCRIBER,
  startTranscriber,
  transcriberWrite,
  editDoc,
  ORIGIN_USER,
  readSegment,
  removeLiveNotes,
  replaceTranscript,
  appendLiveSegment,
  liveModeOf,
  livePlaced,
  markPlaced,
  joinSplitLines,
  initDoc,
  mergeSpeakers,
  renumberSpeakers,
  setSegmentEdits,
  setSegmentText,
  snapshotOf,
  docTranscript,
  upsertSpeaker
} from '../../shared/sessionDoc'
import {
  correctRange,
  removeRange,
  restoreRange,
  toggleHighlight,
  type TranscriptEdit
} from '../../shared/transcriptOverlay'
import { overrideSettings } from '../settings'
import { assignSpeaker } from '../meeting/pipeline'
import { defaultTitle, partOfDay } from '../sessionTitle'
import { trackPath } from '../recorder'
import { sweepAudio } from '../audioRetention'
import { flushLog, log, logPath } from '../log'
import { parseConsentStore } from '../micwatch'
import { ConfigError, parseConfig } from '../config'
import { parseTask } from './args'
import { searchSessions } from '../search'

/** Text the smoke run writes into notes, and the key run-ui-smoke.cjs puts in the environment. */
const NEVER_LOGGED = ['hello from smoke', 'Merged', 'sk-ant-smoke-not-a-real-key']

/** The log holds ids and counts, never what a note says or a key. */
async function checkLogIsContentFree(): Promise<void> {
  await flushLog()
  const path = logPath()
  if (!path) throw new Error('log: no log file')
  const text = await readFile(path, 'utf8')
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      JSON.parse(line)
    } catch {
      throw new Error(`log: a line is not JSON: ${line.slice(0, 120)}`)
    }
  }
  const leaked = NEVER_LOGGED.filter((secret) => text.includes(secret))
  if (leaked.length) throw new Error(`log: contains note content or a key (${leaked.join(', ')})`)
}

/** The environment and task arguments: standard names read, bad values refused by name. */
function checkConfigParsing(): void {
  const fail = (message: string): never => {
    throw new Error(`config: ${message}`)
  }
  const refuses = (run: () => unknown, mention: string): void => {
    try {
      run()
    } catch (error) {
      if (error instanceof ConfigError && error.message.includes(mention)) return
      throw error
    }
    fail(`accepted a bad ${mention}`)
  }
  const parsed = parseConfig({
    HF_ENDPOINT: 'https://hf-mirror.example/',
    ANTHROPIC_API_KEY: ' sk-test ',
    ANTHROPIC_MODEL: 'claude-test',
    LYRA_NOTES_DIR: ''
  })
  if (parsed.hfEndpoint !== 'https://hf-mirror.example' || parsed.anthropicApiKey !== 'sk-test') {
    fail(`parsed wrong: ${JSON.stringify(parsed)}`)
  }
  if (parsed.notesDir !== null || parsed.anthropicModel !== 'claude-test') fail('empty is not unset')
  if (parseConfig({}).hfEndpoint !== 'https://huggingface.co') fail('HF_ENDPOINT default')
  refuses(() => parseConfig({ HF_ENDPOINT: 'not a url' }), 'HF_ENDPOINT')
  refuses(() => parseConfig({ ANTHROPIC_BASE_URL: 'file:///etc' }), 'ANTHROPIC_BASE_URL')
  refuses(() => parseConfig({ LYRA_MODELS_DIR: 'relative/models' }), 'LYRA_MODELS_DIR')

  if (parseTask(['--inspect=9229']) !== null || parseTask([]) !== null) fail('a plain launch ran a task')
  const meeting = parseTask(['--user-data-dir=/tmp/x', 'meeting', '/a/mic.wav', '--offline', '--no-relabel'])
  if (meeting?.kind !== 'meeting' || meeting.pipeline !== 'offline' || meeting.relabel || meeting.system !== null) {
    fail(`meeting task: ${JSON.stringify(meeting)}`)
  }
  refuses(() => parseTask(['meeting']), 'WAV')
  refuses(() => parseTask(['meeting', '/a.wav', '--notes', 'cloud']), '--notes')
  refuses(() => parseTask(['smoke', '--bogus']), '--bogus')
}

/** Checks the Windows mic-usage parser against a captured `reg query` sample. */
function checkConsentParser(): void {
  const root =
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
  const sample = [
    `${root}\\MSTeams_8wekyb3d8bbwe`,
    '    LastUsedTimeStop    REG_QWORD    0x0',
    `${root}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x0',
    `${root}\\NonPackaged\\C:#Apps#Discord.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x1dd78ae61213e7e',
    `${root}\\NonPackaged\\C:#Apps#Lyra#Lyra.exe`,
    '    LastUsedTimeStop    REG_QWORD    0x0'
  ].join('\r\n')
  const users = [...parseConsentStore(sample, 'C:\\Apps\\Lyra\\Lyra.exe')].sort()
  if (users.join(',') !== 'MSTeams,Zoom') {
    throw new Error(`consent parser returned ${users.join(',')}`)
  }
}

/** Session store: concurrent edits merge, the log persists, and the export follows. */
async function checkSessionStore(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`session store: ${message}`)
  }
  const page = await createPage({ startedAt: '2026-02-03T04:05:06' })
  // A new session is titled by when it started, and takes suggestions until the user titles it.
  if (page.title !== defaultTitle(new Date('2026-02-03T04:05:06')) || !page.title.startsWith('Tuesday early morning · Feb 3, 4:05')) {
    fail(`default title is wrong: ${page.title}`)
  }
  const parts = ['00:10', '02:00', '05:30', '09:00', '11:30', '12:10', '15:00', '18:00', '21:00', '23:50']
    .map((time) => partOfDay(new Date(`2026-02-03T${time}:00`)))
  if (parts.join('|') !== 'midnight|late night|early morning|morning|mid-day|noon|afternoon|evening|night|midnight') {
    fail(`parts of the day are wrong: ${parts.join('|')}`)
  }
  if (!(await setAutoTitle(page.id, 'Suggested')) || (await getPage(page.id)).title !== 'Suggested') {
    fail('an untouched title did not take a suggestion')
  }
  const state = await openSessionFor(page.id, -1)

  // Two windows edit the same starting state; both edits must survive.
  const replicas = [new Y.Doc(), new Y.Doc()]
  for (const replica of replicas) Y.applyUpdate(replica, state)
  const send = async (replica: Y.Doc, change: () => void): Promise<void> => {
    const updates: Uint8Array[] = []
    const collect = (update: Uint8Array): void => {
      updates.push(update)
    }
    replica.on('update', collect)
    change()
    replica.off('update', collect)
    for (const update of updates) await applySessionUpdate(page.id, update, -1)
  }
  const [a, b] = replicas
  if (!a || !b) return fail('replicas')
  await send(a, () => {
    editDoc(a, { title: 'Merged', notes: 'first' }, ORIGIN_USER)
  })
  await send(b, () => {
    editDoc(b, { notes: 'second' }, ORIGIN_USER)
  })
  const merged = await getPage(page.id)
  if (merged.title !== 'Merged' || !merged.body.includes('first') || !merged.body.includes('second')) {
    fail(`concurrent edits did not merge: ${JSON.stringify(merged)}`)
  }
  if (await setAutoTitle(page.id, 'Overwritten')) fail('a suggestion replaced the user’s title')
  closeSessionFor(page.id, -1)

  // The log on disk rebuilds the same document.
  const fromDisk = await readSessionFromDisk(page.id)
  if (fromDisk.notes !== merged.body || fromDisk.title !== 'Merged') fail('log did not persist')

  // The export and its metadata follow the document.
  await flushAllSessions()
  const exported = await readFile(join(notesDir(), page.id), 'utf8')
  if (!exported.startsWith('Merged\n\n') || !exported.endsWith(merged.body)) {
    fail(`export is wrong: ${JSON.stringify(exported)}`)
  }
  const sidecar: unknown = JSON.parse(await readFile(sidecarPath(page.id), 'utf8'))
  const meta = sidecar as { schema?: unknown; title?: unknown; editable?: unknown; export?: unknown }
  if (meta.schema !== 'lyra.session/1' || meta.title !== 'Merged' || meta.editable !== false || meta.export !== page.id) {
    fail(`metadata is wrong: ${JSON.stringify(sidecar)}`)
  }

  // An outside edit to the export is kept as a copy before Lyra overwrites it.
  await writeFile(join(notesDir(), page.id), 'edited by another tool', 'utf8')
  await savePage({ id: page.id, title: 'Merged', body: `${merged.body} again` })
  const backups = await readdir(join(notesDir(), '.sessions', page.id, 'external')).catch(() => [])
  if (backups.length !== 1) fail(`outside edit was not backed up (${String(backups.length)})`)

  // A note dropped into the folder becomes a session without its file changing.
  const dropped = 'Dropped note\n\nwritten elsewhere\r\nwith CRLF'
  await writeFile(join(notesDir(), 'dropped-smoke.txt'), dropped, 'utf8')
  const list = await listPages()
  if (list.find((entry) => entry.id === 'dropped-smoke.txt')?.title !== 'Dropped note') {
    fail('dropped note was not listed')
  }
  if ((await readFile(join(notesDir(), 'dropped-smoke.txt'), 'utf8')) !== dropped) {
    fail('migration rewrote the note file')
  }

  for (const id of [page.id, 'dropped-smoke.txt']) {
    await deletePage(id)
    if (existsSync(join(notesDir(), id)) || existsSync(join(notesDir(), '.sessions', id))) {
      fail(`delete left files behind for ${id}`)
    }
  }
}

/** Retention deletes only audio older than the setting, and nothing when set to forever. */
async function checkAudioRetention(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`retention: ${message}`)
  }
  const make = async (endedDaysAgo: number): Promise<string> => {
    const page = await createPage()
    await mkdir(sessionAudioDir(page.id), { recursive: true })
    await writeFile(trackPath(page.id, 'mic'), 'x')
    const endedAt = new Date(Date.now() - endedDaysAgo * 86_400_000).toISOString()
    await updateManifest(page.id, (manifest) => ({
      ...manifest,
      endedAt,
      audio: 'kept',
      tracks: [{ name: 'mic', file: 'mic.wav', sampleRate: 16000, seconds: 1 }]
    }))
    return page.id
  }
  const old = await make(40)
  const fresh = await make(1)
  // Lyra 0.2 kept audio beside the notes; an old file there goes too.
  const legacyDir = join(notesDir(), '.audio')
  await mkdir(legacyDir, { recursive: true })
  const legacy = join(legacyDir, 'retention-legacy.mic.wav')
  await writeFile(legacy, 'x')
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000)
  await utimes(legacy, fortyDaysAgo, fortyDaysAgo)

  overrideSettings({ audioRetentionDays: null })
  if ((await sweepAudio()) !== 0 || !existsSync(trackPath(old, 'mic'))) fail('forever deleted audio')
  overrideSettings({ audioRetentionDays: 30 })
  const deleted = await sweepAudio()
  if (deleted !== 2 || existsSync(trackPath(old, 'mic')) || existsSync(legacy) || !existsSync(trackPath(fresh, 'mic'))) {
    fail(`30 days deleted ${String(deleted)}`)
  }
  await flushAllSessions()
  const sidecar = JSON.parse(await readFile(sidecarPath(old), 'utf8')) as { audioStatus?: unknown; audio?: unknown }
  if (sidecar.audioStatus !== 'deleted' || !Array.isArray(sidecar.audio) || sidecar.audio.length) {
    fail(`metadata still lists deleted audio: ${JSON.stringify(sidecar)}`)
  }
  for (const id of [old, fresh]) await deletePage(id)
}

/** Transcript edits survive a new pass, live text accumulates, and old meetings migrate. */
async function checkTranscriptModel(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`transcript: ${message}`)
  }
  const doc = new Y.Doc()
  // The transcriber writes at its own cursor while the user types around it, and the user's
  // undo never takes transcribed words back.
  const notesText = (): string => snapshotOf(doc).notes
  editDoc(doc, { notes: 'Agenda' }, ORIGIN_USER)
  const undo = new Y.UndoManager(doc.getText('notes'), { trackedOrigins: new Set([ORIGIN_USER]) })
  startTranscriber(doc, ORIGIN_TRANSCRIBER)
  transcriberWrite(doc, '\n\nHello', ORIGIN_TRANSCRIBER)
  editDoc(doc, { notes: `My ${notesText()}` }, ORIGIN_USER)
  undo.stopCapturing()
  editDoc(doc, { notes: `${notesText()} typed` }, ORIGIN_USER)
  transcriberWrite(doc, ' there.', ORIGIN_TRANSCRIBER)
  if (notesText() !== 'My Agenda\n\nHello there. typed') fail(`transcriber cursor: ${JSON.stringify(notesText())}`)
  undo.undo()
  if (notesText() !== 'My Agenda\n\nHello there.') fail(`undo took transcribed text: ${JSON.stringify(notesText())}`)
  undo.destroy()
  // Once labeled, untouched transcribed text comes back out; edited text stays.
  removeLiveNotes(doc, 'pipeline')
  if (notesText() !== 'My Agenda') fail(`live notes: ${JSON.stringify(notesText())}`)
  startTranscriber(doc, ORIGIN_TRANSCRIBER)
  transcriberWrite(doc, ' kept', ORIGIN_TRANSCRIBER)
  editDoc(doc, { notes: 'My Agenda KEPT' }, ORIGIN_USER)
  removeLiveNotes(doc, 'pipeline')
  if (notesText() !== 'My Agenda KEPT') fail('edited live text was removed')
  replaceTranscript(doc, [
    { id: 'a', rawId: 'a', start: 0, end: 4, cluster: 'c0', confidence: 0.9, text: 'Hello there.' },
    { id: 'b', rawId: 'b', start: 4, end: 8, cluster: 'c1', confidence: 0.4, text: 'Hi.' }
  ], 'pipeline')
  setSegmentText(doc, 'b', 'Hi, all.', ORIGIN_USER)
  replaceTranscript(doc, [
    { id: 'a2', rawId: 'a2', start: 0, end: 4.2, cluster: 'c0', confidence: 0.9, text: 'Hello there.' },
    { id: 'b2', rawId: 'b2', start: 4.1, end: 8, cluster: 'c1', confidence: 0.5, text: 'Hi' }
  ], 'pipeline')
  const kept = snapshotOf(doc).transcript.find((segment) => segment.id === 'b2')
  // The kept line keeps the raw words its edits were made over, so the overlay still lines up.
  if (kept?.text !== 'Hi, all.' || !kept.edited || kept.original !== 'Hi.') {
    fail(`an edit did not survive a new pass: ${JSON.stringify(kept)}`)
  }

  // The transcript is locked: edits overlay the raw line, which never changes, and each
  // action undoes on its own.
  replaceTranscript(doc, [
    { id: 'o', rawId: 'o', start: 10, end: 14, cluster: 'c0', confidence: 0.9, text: 'So um the cat sat on teh mat.' }
  ], 'pipeline')
  const heard = 'So um the cat sat on teh mat.'
  const lineEdits = (): TranscriptEdit[] =>
    snapshotOf(doc).transcript.find((segment) => segment.id === 'o')?.edits ?? []
  const overlayUndo = new Y.UndoManager(docTranscript(doc), { trackedOrigins: new Set([ORIGIN_USER]), captureTimeout: 60_000 })
  const at = (word: string): { start: number; end: number } => {
    const start = heard.indexOf(word)
    return { start, end: start + word.length }
  }
  const act = (edits: TranscriptEdit[]): void => {
    overlayUndo.stopCapturing()
    setSegmentEdits(doc, 'o', edits, ORIGIN_USER)
    overlayUndo.stopCapturing()
  }
  act(removeRange(lineEdits(), at('um')))
  act(correctRange(heard, lineEdits(), at('teh'), 'the'))
  act(toggleHighlight(lineEdits(), at('cat sat')))
  const overlaid = snapshotOf(doc).transcript.find((segment) => segment.id === 'o')
  if (overlaid?.text !== 'So the cat sat on the mat.' || overlaid.original !== heard || !overlaid.edited) {
    fail(`overlay: ${JSON.stringify(overlaid)}`)
  }
  if (lineEdits().length !== 3) fail(`overlay edits: ${JSON.stringify(lineEdits())}`)
  overlayUndo.undo()
  overlayUndo.undo()
  const undone = snapshotOf(doc).transcript.find((segment) => segment.id === 'o')
  if (undone?.text !== 'So the cat sat on teh mat.' || undone.edits.length !== 1) {
    fail(`overlay undo should go one action at a time: ${JSON.stringify(undone)}`)
  }
  act(restoreRange(lineEdits(), { start: 0, end: heard.length }))
  if (snapshotOf(doc).transcript.find((segment) => segment.id === 'o')?.text !== heard) {
    fail('restoring a line should bring back what was heard')
  }
  overlayUndo.destroy()
  doc.destroy()

  // Live speakers: phrases become lines for their speaker, one line per turn, and each placed
  // phrase is counted so the window knows which unconfirmed words it still has to draw.
  const live = new Y.Doc()
  initDoc(live, { title: 'Live', notes: '' }, ORIGIN_USER)
  startTranscriber(live, ORIGIN_TRANSCRIBER, 'transcript')
  if (liveModeOf(live) !== 'transcript') fail('a new take should write the transcript')
  markPlaced(live, ORIGIN_TRANSCRIBER)
  if (livePlaced(live) !== 1) fail('placed phrases are not counted')
  const gaps = { joinGap: 2, maxLine: 30 }
  appendLiveSegment(live, { id: 'l1', rawId: null, start: 0, end: 1, cluster: 'c0', confidence: 0.9, text: 'morning all' }, gaps, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l2', rawId: null, start: 1.5, end: 3, cluster: 'c0', confidence: 0.7, text: 'shall we start?' }, gaps, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l3', rawId: null, start: 3.5, end: 5, cluster: 'c1', confidence: null, text: 'yes' }, gaps, ORIGIN_TRANSCRIBER)
  const liveLines = snapshotOf(live).transcript.map((line) => `${line.cluster ?? '?'}:${line.text}:${String(line.confidence)}`)
  if (liveLines.join('|') !== 'c0:Morning all shall we start?:0.7|c1:Yes:null') {
    fail(`live lines: ${JSON.stringify(liveLines)}`)
  }
  // A phantom voice merged back: its split lines rejoin and placeholder names close the gap.
  upsertSpeaker(live, 'c0', { name: 'Speaker 1' }, ORIGIN_TRANSCRIBER)
  upsertSpeaker(live, 'c1', { name: 'Speaker 2' }, ORIGIN_TRANSCRIBER)
  upsertSpeaker(live, 'c2', { name: 'Speaker 3' }, ORIGIN_TRANSCRIBER)
  appendLiveSegment(live, { id: 'l4', rawId: null, start: 5.5, end: 7, cluster: 'c2', confidence: null, text: 'then the plan' }, gaps, ORIGIN_TRANSCRIBER)
  mergeSpeakers(live, 'c1', 'c0', ORIGIN_TRANSCRIBER)
  joinSplitLines(live, 30, ORIGIN_TRANSCRIBER)
  renumberSpeakers(live, ORIGIN_TRANSCRIBER)
  const rejoined = snapshotOf(live)
  const mergedLines = rejoined.transcript.map((line) => `${line.cluster ?? '?'}:${line.text}`).join('|')
  if (mergedLines !== 'c0:Morning all shall we start? Yes|c2:Then the plan') fail(`rejoined lines: ${mergedLines}`)
  if (rejoined.speakers.find((speaker) => speaker.id === 'c2')?.name !== 'Speaker 2') fail('placeholders not renumbered')
  live.destroy()

  // A Lyra 0.2 meeting: labeled lines in the note, speakers in .meta, audio in .audio.
  const id = 'legacy-meeting-smoke.txt'
  await mkdir(join(notesDir(), '.meta'), { recursive: true })
  await mkdir(join(notesDir(), '.audio'), { recursive: true })
  await writeFile(join(notesDir(), '.meta', 'legacy-meeting-smoke.json'), JSON.stringify({
    version: 1,
    speakers: [
      { cluster: 0, name: 'Ana', personId: null, embedding: [0.1, 0.2] },
      { cluster: 1, name: 'Ben', personId: null, embedding: [0.3, 0.4] }
    ],
    liveTranscript: 'rough live text'
  }))
  await writeFile(join(notesDir(), '.audio', 'legacy-meeting-smoke.mic.wav'), Buffer.alloc(44 + 32000))
  await writeFile(join(notesDir(), id), [
    'Weekly sync', '', 'Summary', 'We planned.', '', '──── Transcript ────', '',
    'People: Ana, Ben', '', '[00:00:00] Ana: Morning.', '', '[00:00:04] Ben: Hi Ana.'
  ].join('\n'))
  const listed = await listPages()
  if (!listed.some((entry) => entry.id === id)) fail('legacy meeting not listed')
  const migrated = await readSession(id)
  const lines = migrated.transcript.map((segment) => `${segment.cluster ?? '?'}:${segment.text}`)
  if (lines.join('|') !== 'c0:Morning.|c1:Hi Ana.' || !migrated.summary.includes('We planned.')) {
    fail(`legacy meeting migrated wrong: ${JSON.stringify(migrated)}`)
  }
  if (!existsSync(trackPath(id, 'mic')) || existsSync(join(notesDir(), '.audio', 'legacy-meeting-smoke.mic.wav'))) {
    fail('legacy audio was not moved into the session')
  }
  if (!existsSync(join(sessionRawDir(id), 'legacy.json'))) fail('legacy pass was not kept')
  // Search reaches transcript lines, with who said them and the line to jump to.
  const spoken = (await searchSessions('hi ana')).find((hit) => hit.id === id)
  const said = spoken?.matches.find((match) => match.field === 'transcript')
  if (said?.speaker !== 'Ben' || !said.line) fail(`transcript search missed: ${JSON.stringify(spoken)}`)
  // Editing a line through the document reaches the export.
  await editSession(id, (session) => {
    const segment = session.getArray<Y.Map<unknown>>('transcript').get(1)
    const segmentId = readSegment(segment).id
    setSegmentText(session, segmentId, 'Hi Ana, good morning.', ORIGIN_USER)
  })
  const exported = await readFile(join(notesDir(), id), 'utf8')
  if (!exported.includes('[00:00:04] Ben: Hi Ana, good morning.') || !exported.startsWith('Weekly sync')) {
    fail(`export after a line edit: ${JSON.stringify(exported)}`)
  }
  // Naming a speaker the same as another merges them: one speaker, all their lines.
  // Even when the name also saves a new voice (remember), the same name still merges.
  await assignSpeaker(id, 'c1', { name: 'ana', remember: true })
  const merged = await readSession(id)
  if (merged.speakers.length !== 1 || merged.transcript.some((line) => line.cluster !== 'c0')) {
    fail(`speakers did not merge: ${JSON.stringify(merged.speakers)}`)
  }
  await deletePage(id)
}

export async function runUiSmoke(win: BrowserWindow): Promise<void> {
  try {
    checkConfigParsing()
    checkConsentParser()
    await checkSessionStore()
    await checkAudioRetention()
    await checkTranscriptModel()
    const result: unknown = await win.webContents.executeJavaScript(`
      (async () => {
        const fail = (message) => { throw new Error(message) }
        const list0 = await window.api.listPages()
        const legacy = list0.find((page) => page.id === 'legacy-smoke.md')
        if (!legacy || legacy.title !== 'Legacy page') fail('legacy page was not migrated')

        for (const fileFormat of ['txt', 'md']) {
          await window.api.updateSettings({ fileFormat })
          const created = await window.api.createPage({ startedAt: '2026-01-02T03:04:05' })
          if (!created.id.startsWith('2026-01-02_03-04-05') || !created.id.endsWith('.' + fileFormat)) {
            fail('unexpected file name ' + created.id)
          }
          await window.api.savePage({ id: created.id, title: 'Smoke page', body: 'hello from smoke' })
          const loaded = await window.api.getPage(created.id)
          if (loaded.title !== 'Smoke page' || loaded.body !== 'hello from smoke') {
            fail(fileFormat + ' page did not round-trip: ' + JSON.stringify(loaded))
          }
          const list = await window.api.listPages()
          if (!list.some((page) => page.id === created.id)) fail('page missing from list')
          // Fuzzy: a typo still finds the note, and the match carries highlighted runs.
          const hits = await window.api.searchPages('helo  SMOKE')
          const hit = hits.find((entry) => entry.id === created.id)
          const notesMatch = hit?.matches.find((match) => match.field === 'notes')
          if (!notesMatch?.parts.some((part) => part.hit)) {
            fail(fileFormat + ' search missed the page: ' + JSON.stringify(hits))
          }
          if ((await window.api.searchPages('hello nowhere-in-any-note')).length) fail('search matched a missing word')

          // Untitled: the body's first line must not turn into the title on reload.
          const twoParagraphs = ['First line', '', 'Second'].join(String.fromCharCode(10))
          await window.api.savePage({ id: created.id, title: 'Untitled', body: twoParagraphs })
          const untitled = await window.api.getPage(created.id)
          if (untitled.title !== 'Untitled' || untitled.body !== twoParagraphs) {
            fail(fileFormat + ' untitled page did not round-trip: ' + JSON.stringify(untitled))
          }
          await window.api.deletePage(created.id)
        }

        const session = await window.api.createPage()
        const state = await window.api.openSession(session.id)
        if (!(state instanceof Uint8Array) || state.byteLength === 0) fail('openSession returned no state')
        const badUpdate = await window.api.updateSession(session.id, 'not an update').then(() => false, () => true)
        if (!badUpdate) fail('updateSession accepted a non-binary update')
        window.api.closeSession(session.id)
        await window.api.deletePage(session.id)
        if ((await window.api.listPages()).some((page) => page.id === session.id)) fail('deleted session still listed')
        await window.api.restorePage(session.id)
        if (!(await window.api.listPages()).some((page) => page.id === session.id)) fail('restorePage did not bring the session back')
        const restoredTwice = await window.api.restorePage(session.id).then(() => true, () => false)
        if (restoredTwice) fail('restorePage restored a session that was not deleted')
        await window.api.deletePage(session.id)
        // The key comes from the keychain or ANTHROPIC_API_KEY; a throwaway profile has no keychain key.
        const keySource = await window.api.claudeKeySource()
        if (keySource !== null && keySource !== 'environment') fail('unexpected Claude key source ' + keySource)
        const badModel = await window.api.updateSettings({ claudeModel: 'not a model id!' })
        if (badModel.claudeModel !== null) fail('a malformed Claude model was saved')
        const model = await window.api.updateSettings({ claudeModel: 'claude-test-model' })
        if (model.claudeModel !== 'claude-test-model') fail('the Claude model was not saved')
        await window.api.updateSettings({ claudeModel: null })

        const missingPerson = await window.api.restorePerson('no-such-person').then(() => true, () => false)
        if (missingPerson) fail('restorePerson accepted an unknown id')

        const meetingPage = await window.api.createPage()
        await window.api.startRecording(meetingPage.id, false)
        window.api.appendRecording('mic', new Int16Array(16000).fill(1000))
        window.api.appendRecordingWords([{ text: ' Hello', start: 0.2, end: 0.6 }])
        const recording = await window.api.stopRecording()
        if (!recording || Math.abs(recording.seconds - 1) > 0.01 || recording.systemPath !== null) {
          fail('recording was wrong: ' + JSON.stringify(recording))
        }
        // Recording again continues the same timeline, with the computer's audio padded in.
        await window.api.startRecording(meetingPage.id, true)
        window.api.appendRecording('mic', new Int16Array(8000).fill(500))
        window.api.appendRecording('system', new Int16Array(8000).fill(500))
        const second = await window.api.stopRecording()
        if (!second || Math.abs(second.seconds - 1.5) > 0.01 || !second.systemPath) {
          fail('continued recording was wrong: ' + JSON.stringify(second))
        }
        const heard = await window.api.sessionAudio(meetingPage.id, 0.5, 1.0)
        if (!(heard instanceof Int16Array) || heard.length !== 8000) fail('session audio length ' + heard.length)
        await window.api.deletePage(meetingPage.id)

        for (const bad of ['../escape.txt', '..\\\\escape.txt', '.hidden.txt', 'x/y.txt', 'note.exe']) {
          const rejected = await window.api.getPage(bad).then(() => false, () => true)
          if (!rejected) fail('path guard let through ' + bad)
          const revealRejected = await window.api.revealPage(bad).then(() => false, () => true)
          if (!revealRejected) fail('reveal let through ' + bad)
        }
        return 'ok'
      })()
    `)
    await checkLogIsContentFree()
    process.stdout.write(`ui-smoke: ${String(result)}
`)
    app.exit(0)
  } catch (error) {
    log('ui-smoke', 'failed', error)
    app.exit(1)
  }
}

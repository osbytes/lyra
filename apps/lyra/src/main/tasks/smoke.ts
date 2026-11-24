/** `lyra smoke`: main-process checks, then the IPC bridge exercised from the renderer. */
import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesDir } from '../pages'
import { ChunkedTranscriber } from '../transcriber'
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
  restoreSession,
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
  joinSplitLines,
  initDoc,
  mergeSpeakers,
  renumberSpeakers,
  setSegmentEdits,
  setSegmentText,
  snapshotOf,
  docTranscript,
  upsertSpeaker,
  addTag
} from '../../shared/sessionDoc'
import {
  correctRange,
  removeRange,
  restoreRange,
  toggleHighlight,
  type TranscriptEdit
} from '../../shared/transcriptOverlay'
import { getSettings, overrideSettings } from '../settings'
import { assignSpeaker } from '../meeting/pipeline'
import { defaultTitle, partOfDay } from '../sessionTitle'
import { trackPath } from '../recorder'
import { sweepAudio } from '../audioRetention'
import { flushLog, log, logPath } from '../log'
import { parseConsentStore } from '../micwatch'
import { ConfigError, parseConfig } from '../config'
import { parseTask } from './args'
import { MockLanguageModelV4 } from 'ai/test'
import type { ProviderId } from '../../shared/ai'
import { parseSettings, type Settings } from '../../shared/settings'
import { createMeetingNotes } from '../meeting/notes'
import { createFakeNotesWriter, createModelNotesWriter } from '../meeting/notesWriter'
import { chooseWriter } from '../meeting/writers'
import { searchSessions } from '../search'
import { checkSearchIndex } from '../searchIndex/service'
import { addPerson, deletePerson } from '../voices'

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

/** Older and hand-edited settings files: migrated, and a bad field falls back on its own. */
function checkSettingsSchema(): void {
  const base = getSettings()
  const old = parseSettings({ notesEngine: 'claude', keepMeetingAudio: true, hotkey: 42, fileFormat: 'md' }, base)
  if (old.notesEngine !== 'cloud' || old.cloudProvider !== 'anthropic' || old.audioRetentionDays !== null) {
    throw new Error(`settings: 0.3 file not migrated: ${JSON.stringify(old)}`)
  }
  if (old.hotkey !== base.hotkey || old.fileFormat !== 'md') throw new Error('settings: a bad field took good ones with it')
  if (parseSettings('not an object', base).notesDir !== base.notesDir) throw new Error('settings: junk input')
}

/**
 * The NotesWriter seam: Settings choose the writer, the AI SDK adapter turns a model's structured
 * output into notes, and the notes service writes them, all without a network or a real model.
 */
async function checkNotesWriters(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`notes writers: ${message}`)
  }
  const notes = {
    decisions: [' Ship Friday '],
    actionItems: [{ owner: 'Sam', task: 'Fix the installer' }, { owner: '', task: 'Update the changelog' }],
    openQuestions: [''],
    summary: ' Planned the release. '
  }
  const local = createFakeNotesWriter({ notes, title: 'Local title' })
  const withSettings = (patch: Partial<Settings>, keys: Partial<Record<ProviderId, string>> = {}) =>
    chooseWriter({
      settings: () => ({ ...getSettings(), ...patch }),
      apiKey: (provider) => Promise.resolve(keys[provider] ?? null),
      baseUrls: { anthropic: null, openai: null },
      local
    })
  if ((await withSettings({ notesEngine: 'off' })) !== null) fail('off still chose a writer')
  if ((await withSettings({ notesEngine: 'local' })) !== local) fail('local did not choose the local writer')
  const refused = async (patch: Partial<Settings>, mention: string): Promise<void> => {
    const message = await withSettings(patch).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    if (!message.includes(mention)) fail(`${JSON.stringify(patch)} was not refused (${message})`)
  }
  await refused({ notesEngine: 'cloud', cloudProvider: 'anthropic' }, 'API key')
  await refused({ notesEngine: 'cloud', cloudProvider: 'openai', cloudModel: null }, 'model')
  await refused({ notesEngine: 'cloud', cloudProvider: 'openai-compatible', cloudModel: 'llama3', cloudBaseUrl: null }, 'server address')
  const cloud = await withSettings({ notesEngine: 'cloud', cloudProvider: 'anthropic' }, { anthropic: 'sk-test' })
  if (cloud?.name !== 'Anthropic (claude-opus-5-5)') fail(`cloud writer: ${cloud?.name ?? 'none'}`)

  // The AI SDK adapter against a mock model: structured output parsed by the zod schema, tidied.
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(notes) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 }
        },
        warnings: []
      })
  })
  const written = await createModelNotesWriter(model, 'mock').notes('Sam: I will fix the installer.')
  if (written.summary !== 'Planned the release.' || written.decisions.join() !== 'Ship Friday') {
    fail(`adapter did not tidy: ${JSON.stringify(written)}`)
  }
  if (written.actionItems[1]?.owner !== 'Unassigned' || written.openQuestions.length) fail('adapter kept empty entries')
  const bad = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: '{"summary": 3}' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }
        },
        warnings: []
      })
  })
  const rejected = await createModelNotesWriter(bad, 'mock').notes('x').then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  if (!rejected.includes('expected shape')) fail(`malformed output was accepted (${rejected})`)

  // The notes service writes what its writer returns into the session.
  const page = await createPage()
  await editSession(page.id, (doc) => {
    replaceTranscript(doc, [{ id: 'n0', rawId: 'n0', start: 0, end: 2, cluster: null, confidence: null, text: 'We ship Friday.' }], 'seed')
  })
  const service = createMeetingNotes({ writer: () => Promise.resolve(local) })
  await service.generateNotes(page.id)
  const summary = (await readSession(page.id)).summary
  if (!summary.includes('Fix the installer') || local.asked.length !== 1) fail(`service summary: ${JSON.stringify(summary)}`)
  await deletePage(page.id)
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
    OPENAI_API_KEY: 'sk-openai',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
    LYRA_NOTES_DIR: ''
  })
  if (parsed.hfEndpoint !== 'https://hf-mirror.example' || parsed.apiKeys.anthropic !== 'sk-test') {
    fail(`parsed wrong: ${JSON.stringify(parsed.hfEndpoint)}`)
  }
  if (parsed.apiKeys.openai !== 'sk-openai' || parsed.apiKeys.google !== null || parsed.notesDir !== null) {
    fail('keys or empty values parsed wrong')
  }
  if (parseConfig({}).hfEndpoint !== 'https://huggingface.co') fail('HF_ENDPOINT default')
  refuses(() => parseConfig({ HF_ENDPOINT: 'not a url' }), 'HF_ENDPOINT')
  refuses(() => parseConfig({ ANTHROPIC_BASE_URL: 'file:///etc' }), 'ANTHROPIC_BASE_URL')
  refuses(() => parseConfig({ LYRA_MODELS_DIR: 'relative/models' }), 'LYRA_MODELS_DIR')

  if (parseTask(['--inspect=9229']) !== null || parseTask([]) !== null) fail('a plain launch ran a task')
  const meeting = parseTask(['--user-data-dir=/tmp/x', 'meeting', '/a/mic.wav', '--offline', '--no-relabel'])
  if (meeting?.kind !== 'meeting' || meeting.pipeline !== 'offline' || meeting.relabel || meeting.system !== null) {
    fail(`meeting task: ${JSON.stringify(meeting)}`)
  }
  const enrolled = parseTask(['meeting', '/a/mic.wav', '--enroll', '/a/me.wav'])
  if (enrolled?.kind !== 'meeting' || enrolled.enroll === null) {
    fail(`meeting --enroll: ${JSON.stringify(enrolled)}`)
  }
  refuses(() => parseTask(['meeting']), 'WAV')
  refuses(() => parseTask(['meeting', '/a.wav', '--notes', 'claude']), '--notes')
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

/**
 * The search index mirrors sessions and people: what it holds reads back equal to what the
 * files say, through edits, a delete, an undo and a voice saved.
 */
async function checkSearchIndexMirror(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`search index: ${message}`)
  }
  const expectInSync = async (step: string): Promise<void> => {
    const result = await checkSearchIndex()
    if (result.mismatched.length) fail(`${step}: out of sync for ${result.mismatched.join(', ')}`)
  }
  const page = await createPage({ startedAt: '2026-03-04T05:06:07' })
  await editSession(page.id, (doc) => {
    editDoc(
      doc,
      {
        title: 'Index smoke',
        notes: 'Budget review\n\nShip the release notes',
        summary: 'Summary\nWe met.\n\nAction items\n- [ ] Ana: send the deck\n- [x] wrap up'
      },
      'main'
    )
    addTag(doc, 'Planning', 'main')
    upsertSpeaker(doc, 'c0', { name: 'Ana', confirmed: true, confidence: 0.91, matches: [{ personId: 'p1', score: 0.91 }] }, 'main')
    upsertSpeaker(doc, 'c1', { name: 'Speaker 2' }, 'main')
    replaceTranscript(
      doc,
      [
        { id: 's1', rawId: 'pass-1-s1', start: 0.25, end: 3.7, cluster: 'c0', confidence: 0.83, text: 'The quarterly budget is ready.' },
        { id: 's2', rawId: null, start: 3.7, end: 6.1, cluster: 'c1', confidence: null, text: 'Great, thanks Ana.' }
      ],
      'main'
    )
    setSegmentEdits(doc, 's1', [{ kind: 'replace', start: 4, end: 13, text: 'yearly' }, { kind: 'highlight', start: 14, end: 20 }], ORIGIN_USER)
  })
  await expectInSync('after an edit')
  const record = await readSessionFromDisk(page.id)
  if (!record.transcript.some((line) => line.edited)) fail('the edit did not land')

  await deletePage(page.id)
  await expectInSync('after a delete')
  await restoreSession(page.id)
  await expectInSync('after an undo')

  const person = await addPerson('Index Person', [0.1, 0.2, 0.30000000000000004], false)
  await expectInSync('after saving a voice')
  await deletePerson(person.id)
  await expectInSync('after deleting a voice')
  await deletePage(page.id)
  await expectInSync('at the end')
}

/**
 * Search on the index: a fixed set of sessions and queries with the results each must give
 * (docs/SEARCH-INDEX.md, Phase 2). Ids are compared among these sessions only.
 */
async function checkSearchQueries(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`search: ${message}`)
  }
  const make = async (
    startedAt: string,
    fields: { title: string; notes: string; tag: string },
    lines: { cluster: string; name: string; text: string }[]
  ): Promise<string> => {
    const page = await createPage({ startedAt })
    await editSession(page.id, (doc) => {
      editDoc(doc, { title: fields.title, notes: fields.notes }, 'main')
      addTag(doc, fields.tag, 'main')
      for (const line of lines) upsertSpeaker(doc, line.cluster, { name: line.name }, 'main')
      replaceTranscript(
        doc,
        lines.map((line, i) => ({ id: `q${String(i)}`, rawId: null, start: i * 5, end: i * 5 + 4, cluster: line.cluster, confidence: null, text: line.text })),
        'main'
      )
    })
    return page.id
  }
  const budget = await make(
    '2026-04-01T10:00:00',
    { title: 'Quarterly budget review', notes: 'We discussed the marketing budgets and hiring.', tag: 'Finance' },
    [
      { cluster: 'c0', name: 'Ana', text: 'Revenue grew in Europe.' },
      { cluster: 'c1', name: 'Bob', text: 'Dillon will send the deck.' }
    ]
  )
  const design = await make(
    '2026-05-10T10:00:00',
    { title: 'Design sync', notes: 'Mockups for the onboarding flow.', tag: 'design' },
    [{ cluster: 'c0', name: 'Carla', text: 'The meeting ran long.' }]
  )
  const weekly = await make(
    '2026-07-01T10:00:00',
    { title: 'Weekly notes', notes: 'The budget came up once, in passing.', tag: 'weekly' },
    []
  )
  const ours = new Set([budget, design, weekly])
  const ids = async (query: string): Promise<string[]> =>
    (await searchSessions(query)).map((hit) => hit.id).filter((id) => ours.has(id))
  const expect = async (query: string, expected: string[]): Promise<void> => {
    const got = await ids(query)
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      fail(`"${query}" gave ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
    }
  }
  await expect('budget', [budget, weekly]) // a title match outranks a notes match
  await expect('budgets', [budget, weekly]) // stems
  await expect('budg', [budget, weekly]) // prefixes, while typing
  await expect('buget', [budget, weekly]) // a typo
  await expect('meetign', [design]) // a typo of a word whose stem is shorter
  await expect('illo', [budget]) // part of a word ("Dillon")
  await expect('person:ana', [budget]) // filters alone, newest first
  await expect('speaker:carla meeting', [design])
  await expect('tag:Design', [design])
  await expect('after:2026-06 budget', [weekly])
  await expect('before:2026-05 budget', [budget])
  await expect('xyzzy', [])
  const said = (await searchSessions('revenue europe')).find((hit) => hit.id === budget)
  const line = said?.matches.find((match) => match.field === 'transcript')
  if (line?.speaker !== 'Ana' || line.line !== 'q0' || line.start !== 0) {
    return fail(`transcript hit: ${JSON.stringify(said)}`)
  }
  const marked = line.parts.filter((part) => part.hit).map((part) => part.text.toLowerCase())
  if (marked.join('|') !== 'revenue|europe') fail(`highlights: ${JSON.stringify(line.parts)}`)
  for (const id of ours) await deletePage(id)
  await expect('budget', [])
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
/** A tone loud enough to count as speech, `seconds` long, into `out` from `at` seconds. */
function tone(out: Float32Array, at: number, seconds: number, gain = 0.2): void {
  const from = Math.round(at * 16000)
  for (let i = 0; i < seconds * 16000 && from + i < out.length; i++) {
    out[from + i] = gain * Math.sin((2 * Math.PI * 220 * i) / 16000)
  }
}

/**
 * Chunked transcription without Whisper: chunks are cut at pauses on each track, the far end's
 * echo in the mic is gated out, a long stretch is cut before Whisper's 30 s window, and results
 * come out in the order their audio started.
 */
async function checkChunkedTranscriber(): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`chunked transcription: ${message}`)
  }
  const mic = new Float32Array(50 * 16000)
  const system = new Float32Array(50 * 16000)
  tone(mic, 0.5, 2.5)
  tone(system, 5, 3)
  // The far end, played on speakers, reaches the mic a little quieter and later.
  tone(mic, 5.05, 3, 0.16)
  tone(mic, 10, 35)
  const cuts: { start: number; seconds: number }[] = []
  const out: string[] = []
  const transcriber = new ChunkedTranscriber(
    ['mic', 'system'],
    0,
    async (pcm) => {
      cuts.push({ start: 0, seconds: pcm.length / 16000 })
      // Later chunks finish first, to check the order results come out in.
      await new Promise((resolve) => setTimeout(resolve, cuts.length === 1 ? 30 : 0))
      return [{ text: ' words', start: 0, end: pcm.length / 16000 }]
    },
    (chunk) => out.push(`${chunk.track}@${chunk.start.toFixed(1)}`)
  )
  for (let at = 0; at < mic.length; at += 16000) {
    transcriber.audio('mic', mic.subarray(at, at + 16000))
    transcriber.audio('system', system.subarray(at, at + 16000))
  }
  await transcriber.finish()
  const tracks = out.map((entry) => entry.split('@')[0] ?? '')
  if (tracks.slice(0, 2).join(',') !== 'mic,system') fail(`chunks out of order or echo kept: ${out.join(' ')}`)
  if (out.some((entry) => /^mic@[4-8]/.test(entry))) fail(`the far end's echo was transcribed as the mic: ${out.join(' ')}`)
  if (cuts.some((cut) => cut.seconds > 28.5)) fail(`a chunk ran past Whisper's window: ${JSON.stringify(cuts)}`)
  if (tracks.filter((track) => track === 'mic').length < 3) fail(`a long stretch was not cut: ${out.join(' ')}`)
  if (transcriber.progress().queued !== 0) fail('chunks still queued after finishing')
}

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

  // Recorded lines: chunks become lines for their speaker, one line per turn.
  const live = new Y.Doc()
  initDoc(live, { title: 'Live', notes: '' }, ORIGIN_USER)
  startTranscriber(live, ORIGIN_TRANSCRIBER, 'transcript')
  if (liveModeOf(live) !== 'transcript') fail('a new take should write the transcript')
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
    checkSettingsSchema()
    await checkNotesWriters()
    checkConsentParser()
    await checkSessionStore()
    await checkAudioRetention()
    await checkTranscriptModel()
    await checkChunkedTranscriber()
    await checkSearchIndexMirror()
    await checkSearchQueries()
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
        const keySource = await window.api.keySource('anthropic')
        if (keySource !== null && keySource !== 'environment') fail('unexpected Claude key source ' + keySource)
        if ((await window.api.keySource('openai-compatible')) !== null) fail('a key appeared for a local server')
        const badProvider = await window.api.keySource('not-a-provider').then(() => false, () => true)
        if (!badProvider) fail('keySource accepted an unknown provider')
        const badModel = await window.api.updateSettings({ cloudModel: 'not a model id!' })
        if (badModel.cloudModel !== null) fail('a malformed model id was saved')
        const model = await window.api.updateSettings({ cloudProvider: 'openai-compatible', cloudModel: 'llama3.1:8b', cloudBaseUrl: 'http://localhost:11434/v1' })
        if (model.cloudModel !== 'llama3.1:8b' || model.cloudBaseUrl !== 'http://localhost:11434/v1') fail('the cloud model was not saved')
        const badUrl = await window.api.updateSettings({ cloudBaseUrl: 'ftp://nope' })
        if (badUrl.cloudBaseUrl !== 'http://localhost:11434/v1') fail('a non-http server address was saved')
        await window.api.updateSettings({ cloudProvider: 'anthropic', cloudModel: null, cloudBaseUrl: null })

        const missingPerson = await window.api.restorePerson('no-such-person').then(() => true, () => false)
        if (missingPerson) fail('restorePerson accepted an unknown id')

        const meetingPage = await window.api.createPage()
        await window.api.startRecording(meetingPage.id, false)
        window.api.appendRecording('mic', new Int16Array(16000).fill(1000))
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
        // Too few lines to compare: nothing to suggest, and bad input is refused.
        const similar = await window.api.similarLines(meetingPage.id, ['nope'], 'c0')
        if (!Array.isArray(similar) || similar.length !== 0) fail('similarLines on an empty session: ' + JSON.stringify(similar))
        const badSimilar = await window.api.similarLines(meetingPage.id, 'nope', 'c0').then(() => false, () => true)
        if (!badSimilar) fail('similarLines accepted a non-array')
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

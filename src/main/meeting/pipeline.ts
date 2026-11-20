import { BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MeetingRecording,
  MeetingSpeaker,
  MeetingStatus,
  SpeakerAssignment
} from '../../shared/types'
import { log } from '../log'
import { getPage, notesDir, notifyPagesChanged, resolveInNotes, savePage } from '../pages'
import { onRecordingFinished } from '../recorder'
import { getSettings } from '../settings'
import {
  addPerson,
  addSample,
  cosine,
  deletePerson,
  getPerson,
  listPeople,
  scoreVoices,
  renamePerson,
  selfPerson,
  setSelf,
  type VoiceMatch
} from '../voices'
import { transcribePcm } from '../whisper'
import { splitNotes, TRANSCRIPT_DIVIDER } from './notesFormat'
import type { DiarizeResult, DiarizedSegment } from './protocol'
import { diarize, embedVoice, ensureSpeakerModels } from './speakers'
import { mixTracks, readWav } from './wav'

/** Merge a speaker's segments separated by less than this into one turn. */
const MERGE_GAP_SECONDS = 1
/** Whisper works on ≤30 s windows; keep turns comfortably under that. */
const MAX_TURN_SECONDS = 25
/** A speaker whose audio is mostly on the mic track is the person at this computer. */
const SELF_MIC_SHARE = 0.67
/**
 * Cosine similarity needed to name a speaker from a saved voice. Different people
 * score ~0.45 with this model; the same person across calls lands ~0.55–0.95,
 * lower when the voiceprint is one short clip, so the bar sits just above strangers.
 */
const MATCH_THRESHOLD = 0.5
/** A match this strong is added to the person's voiceprint automatically. */
const REINFORCE_THRESHOLD = 0.75
/** Below this much total speech, a "speaker" is folded into the closest real one. */
const MIN_SPEAKER_SECONDS = 2
/** Clustering distance threshold for diarization. */
const CLUSTER_THRESHOLD = 0.5
const PROMPT_CHARS = 200
const LINE = /^(\[\d{2}:\d{2}:\d{2}\] )(.+?): /

type StoredSpeaker = MeetingSpeaker & { embedding: number[] }
type MeetingMeta = { version: 1; speakers: StoredSpeaker[]; liveTranscript: string }
type Turn = { start: number; end: number; speaker: number }

const completedListeners = new Set<(pageId: string) => void>()

/** Fires after a meeting's transcript has been labeled (meeting notes hook in here). */
export function onMeetingLabeled(listener: (pageId: string) => void): () => void {
  completedListeners.add(listener)
  return () => completedListeners.delete(listener)
}

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

function metaPath(pageId: string): string {
  resolveInNotes(pageId)
  return join(notesDir(), '.meta', `${pageId.replace(/\.(txt|md)$/i, '')}.json`)
}

async function readMeta(pageId: string): Promise<MeetingMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath(pageId), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const meta = parsed as Partial<MeetingMeta>
    return meta.version === 1 && Array.isArray(meta.speakers)
      ? { version: 1, speakers: meta.speakers, liveTranscript: meta.liveTranscript ?? '' }
      : null
  } catch {
    return null
  }
}

async function writeMeta(pageId: string, meta: MeetingMeta): Promise<void> {
  const path = metaPath(pageId)
  await mkdir(join(notesDir(), '.meta'), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(meta), 'utf8')
  await rename(`${path}.tmp`, path)
}

/**
 * Folds "speakers" with almost no speech into the closest-sounding real speaker.
 * A voiceprint from a fraction of a second ("That's that.") is mostly noise, so the
 * diarizer tends to give such a fragment its own cluster: a phantom extra person.
 */
export function mergeTinySpeakers(result: DiarizeResult): DiarizeResult {
  const seconds = new Map<number, number>()
  for (const segment of result.segments) {
    seconds.set(segment.speaker, (seconds.get(segment.speaker) ?? 0) + segment.end - segment.start)
  }
  const real = result.clusters.filter((c) => (seconds.get(c.speaker) ?? 0) >= MIN_SPEAKER_SECONDS)
  // With nobody past the bar there's nothing better to merge into.
  if (real.length === 0) return result

  const into = new Map<number, number>()
  for (const cluster of result.clusters) {
    if (real.includes(cluster)) continue
    let best = real[0]
    let bestScore = -Infinity
    for (const candidate of real) {
      const score = cosine(cluster.embedding, candidate.embedding)
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (best) into.set(cluster.speaker, best.speaker)
  }
  if (into.size === 0) return result
  log('meeting', 'merged tiny speakers', Object.fromEntries(into))
  return {
    ...result,
    segments: result.segments.map((s) => ({ ...s, speaker: into.get(s.speaker) ?? s.speaker })),
    clusters: real
  }
}

/** Joins each speaker's nearby segments into turns, split so none exceeds MAX_TURN_SECONDS. */
export function buildTurns(segments: readonly DiarizedSegment[]): Turn[] {
  const turns: Turn[] = []
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const last = turns.at(-1)
    if (
      last?.speaker === segment.speaker &&
      segment.start - last.end < MERGE_GAP_SECONDS &&
      segment.end - last.start <= MAX_TURN_SECONDS
    ) {
      last.end = Math.max(last.end, segment.end)
      continue
    }
    for (let start = segment.start; start < segment.end; start += MAX_TURN_SECONDS) {
      turns.push({ start, end: Math.min(segment.end, start + MAX_TURN_SECONDS), speaker: segment.speaker })
    }
  }
  return turns
}

/** Names each cluster: a saved voice, else "you" when it's mostly the mic track, else Speaker N. */
async function nameSpeakers(result: DiarizeResult, hasSystemTrack: boolean): Promise<StoredSpeaker[]> {
  const me = await selfPerson()
  const order = [...new Set([...result.segments].sort((a, b) => a.start - b.start).map((s) => s.speaker))]

  // Score every speaker against every saved voice, then hand out names best-first,
  // so each person labels one speaker and each speaker gets at most one name.
  const scored = await Promise.all(
    result.clusters.map(async (cluster) => ({
      speaker: cluster.speaker,
      embedding: cluster.embedding,
      scores: await scoreVoices(cluster.embedding)
    }))
  )
  const assigned = new Map<number, VoiceMatch>()
  const taken = new Set<string>()
  const pairs = scored
    .flatMap(({ speaker, scores }) => scores.map((match) => ({ speaker, match })))
    .filter(({ match }) => match.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.match.score - a.match.score)
  for (const { speaker, match } of pairs) {
    if (assigned.has(speaker) || taken.has(match.person.id)) continue
    assigned.set(speaker, match)
    taken.add(match.person.id)
  }
  for (const { speaker, scores } of scored) {
    const best = scores[0]
    log('meeting', 'voice match', {
      speaker,
      best: best ? { name: best.person.name, score: +best.score.toFixed(3) } : null,
      assigned: assigned.get(speaker)?.person.name ?? null
    })
  }
  // Confident matches teach the voiceprint, so it keeps up with mics and rooms.
  for (const { speaker, embedding } of scored) {
    const match = assigned.get(speaker)
    if (match && match.score >= REINFORCE_THRESHOLD && embedding.length) {
      await addSample(match.person.id, embedding)
    }
  }

  const selfName = me?.name ?? 'Me'
  // The mic-track hint can't override a voice match that already found "me".
  let selfAssigned = me ? taken.has(me.id) : false
  let unknown = 0
  const speakers: StoredSpeaker[] = []
  for (const speaker of order) {
    const cluster = result.clusters.find((entry) => entry.speaker === speaker)
    const match = assigned.get(speaker)
    const own = result.segments.filter((segment) => segment.speaker === speaker)
    const duration = own.reduce((sum, s) => sum + (s.end - s.start), 0)
    const micShare = duration
      ? own.reduce((sum, s) => sum + s.micShare * (s.end - s.start), 0) / duration
      : 0

    let name: string
    let personId: string | null = null
    if (match) {
      name = match.person.name
      personId = match.person.id
    } else if (hasSystemTrack && micShare >= SELF_MIC_SHARE && !selfAssigned) {
      selfAssigned = true
      name = selfName
      personId = me?.id ?? null
    } else {
      unknown++
      name = `Speaker ${unknown}`
    }
    speakers.push({ cluster: speaker, name, personId, embedding: cluster?.embedding ?? [] })
  }
  return speakers
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

function peopleLine(speakers: readonly MeetingSpeaker[]): string {
  return `People: ${speakers.map((speaker) => speaker.name).join(', ')}`
}

async function transcribeTurns(
  recording: MeetingRecording,
  turns: Turn[],
  speakers: StoredSpeaker[],
  onProgress: (done: number) => void
): Promise<string[]> {
  const lines: string[] = []
  let context = ''
  for (const [index, turn] of turns.entries()) {
    const mic = await readWav(recording.micPath, turn.start, turn.end)
    const system = recording.systemPath
      ? await readWav(recording.systemPath, turn.start, turn.end)
      : null
    const words = await transcribePcm(mixTracks(mic, system), context.slice(-PROMPT_CHARS))
    const text = words.map((word) => word.text).join('').trim()
    onProgress(index + 1)
    if (!text) continue
    context += ` ${text}`
    const name = speakers.find((speaker) => speaker.cluster === turn.speaker)?.name ?? 'Speaker'
    const previous = lines.at(-1)
    // Consecutive turns by the same speaker read better as one paragraph.
    if (previous?.includes(`] ${name}: `)) {
      lines[lines.length - 1] = `${previous} ${text}`
    } else {
      lines.push(`[${clock(turn.start)}] ${name}: ${text}`)
    }
  }
  return lines
}

async function deleteAudio(recording: MeetingRecording): Promise<void> {
  for (const path of [recording.micPath, recording.systemPath]) {
    if (path) await unlink(path).catch(() => undefined)
  }
}

/** Labels a finished recording: diarize, name speakers, transcribe turns, rewrite the note. */
export async function processMeeting(recording: MeetingRecording): Promise<void> {
  const { pageId } = recording
  const status = (state: MeetingStatus['state'], progress: number, message?: string): void => {
    broadcast({ pageId, state, progress, ...(message ? { message } : {}) })
  }
  log('meeting', 'processing', { pageId, seconds: +recording.seconds.toFixed(1) })

  const models = await ensureSpeakerModels((received, total) => {
    status('downloading', total ? received / total : 0)
  })

  status('diarizing', 0)
  const started = Date.now()
  const result = await diarize({
    micPath: recording.micPath,
    systemPath: recording.systemPath,
    models,
    threshold: CLUSTER_THRESHOLD
  })
  log('meeting', 'diarized', {
    pageId,
    speakers: result.clusters.length,
    segments: result.segments.length,
    rtf: +((Date.now() - started) / 1000 / Math.max(1, result.seconds)).toFixed(3)
  })

  const merged = mergeTinySpeakers(result)
  const speakers = await nameSpeakers(merged, recording.systemPath !== null)
  const turns = buildTurns(merged.segments)
  status('transcribing', 0)
  const lines = await transcribeTurns(recording, turns, speakers, (done) => {
    status('transcribing', done / Math.max(1, turns.length))
  })

  const page = await getPage(pageId)
  const body = lines.length ? `${peopleLine(speakers)}\n\n${lines.join('\n\n')}` : page.body
  await writeMeta(pageId, { version: 1, speakers, liveTranscript: page.body })
  await savePage({ id: pageId, title: page.title, body })
  notifyPagesChanged()
  if (!getSettings().keepMeetingAudio) await deleteAudio(recording)

  status('done', 1)
  log('meeting', 'labeled', { pageId, turns: lines.length })
  for (const listener of completedListeners) listener(pageId)
}

let queue: Promise<void> = Promise.resolve()

function enqueue(recording: MeetingRecording): void {
  queue = queue.then(
    () => processMeeting(recording),
    () => processMeeting(recording)
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    log('meeting', 'processing failed', { pageId: recording.pageId, error: message })
    broadcast({ pageId: recording.pageId, state: 'error', progress: 0, message })
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Rewrites "Old:" speaker prefixes, the People line, and names in the notes after a relabel. */
function relabel(body: string, from: string, to: string, speakers: readonly MeetingSpeaker[]): string {
  const { notes, transcript } = splitNotes(body)
  const lines = transcript
    .split('\n')
    .map((line) => {
      if (line.startsWith('People: ')) return peopleLine(speakers)
      const match = LINE.exec(line)
      return match?.[1] && match[2] === from ? `${match[1]}${to}: ${line.slice(match[0].length)}` : line
    })
    .join('\n')
  if (!notes) return lines
  const renamed = notes.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to)
  return `${renamed}\n\n${TRANSCRIPT_DIVIDER}\n\n${lines}`
}

export async function assignSpeaker(
  pageId: string,
  cluster: number,
  assignment: SpeakerAssignment
): Promise<void> {
  const meta = await readMeta(pageId)
  const speaker = meta?.speakers.find((entry) => entry.cluster === cluster)
  if (!meta || !speaker) throw new Error('This meeting has no such speaker')

  let name: string
  let personId: string | null
  if ('personId' in assignment) {
    const person = await getPerson(assignment.personId)
    if (!person) throw new Error('That person no longer exists')
    name = person.name
    personId = person.id
    // Teach the voiceprint this sample, so the person is recognized next time.
    if (speaker.embedding.length) await addSample(person.id, speaker.embedding)
  } else {
    name = assignment.name.trim()
    if (!name) throw new Error('A name is required')
    personId = null
    if (assignment.remember && speaker.embedding.length) {
      personId = (await addPerson(name, speaker.embedding, false)).id
    }
  }

  const previous = speaker.name
  const speakers = meta.speakers.map((entry) =>
    entry.cluster === cluster ? { ...entry, name, personId } : entry
  )
  await writeMeta(pageId, { ...meta, speakers })
  const page = await getPage(pageId)
  await savePage({ id: pageId, title: page.title, body: relabel(page.body, previous, name, speakers) })
  notifyPagesChanged()
  log('meeting', 'relabeled speaker', { pageId, cluster, remembered: personId !== null })
}

function parseAssignment(value: unknown): SpeakerAssignment {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>
    if (typeof raw.personId === 'string') return { personId: raw.personId }
    if (typeof raw.name === 'string') return { name: raw.name, remember: raw.remember === true }
  }
  throw new Error('Invalid speaker assignment')
}

function pcmFrom(payload: unknown): Float32Array {
  if (payload instanceof Float32Array) return payload
  if (ArrayBuffer.isView(payload) && payload.byteLength % 4 === 0) {
    return new Float32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))
  }
  throw new Error('Invalid audio')
}

/** `processRecordings: false` (test runs) keeps the IPC but doesn't label recordings. */
export function registerMeetingPipeline({ processRecordings }: { processRecordings: boolean }): void {
  if (processRecordings) onRecordingFinished(enqueue)

  ipcMain.handle('people:list', () => listPeople())
  ipcMain.handle('people:enroll', async (_event, name: unknown, pcm: unknown, self: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid name')
    const models = await ensureSpeakerModels()
    const embedding = await embedVoice(pcmFrom(pcm), models)
    return addPerson(name, embedding, self === true)
  })
  ipcMain.handle('people:rename', (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Invalid input')
    return renamePerson(id, name)
  })
  ipcMain.handle('people:setSelf', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid input')
    return setSelf(id)
  })
  ipcMain.handle('people:delete', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid input')
    return deletePerson(id)
  })
  ipcMain.handle('meeting:speakers', async (_event, pageId: unknown) => {
    if (typeof pageId !== 'string') throw new Error('Invalid page id')
    const meta = await readMeta(pageId)
    return meta ? meta.speakers.map(({ cluster, name, personId }) => ({ cluster, name, personId })) : null
  })
  ipcMain.handle('meeting:assign', (_event, pageId: unknown, cluster: unknown, assignment: unknown) => {
    if (typeof pageId !== 'string' || typeof cluster !== 'number') throw new Error('Invalid input')
    return assignSpeaker(pageId, cluster, parseAssignment(assignment))
  })
}

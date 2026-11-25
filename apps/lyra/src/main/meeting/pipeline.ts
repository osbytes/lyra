import { ipcMain, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MeetingRecording,
  MeetingStatus,
  SpeakerAssignment,
  SpeakerIdentity,
  TranscriptWord
} from '../../shared/types'
import {
  mergeSpeakers,
  removeLiveNotes,
  speakerToMergeInto,
  replaceTranscript,
  upsertSpeaker,
  type NewSegment,
  type SpeakerMatch
} from '../../shared/sessionDoc'
import { log } from '../log'
import { resolveInNotes } from '../pages'
import { deleteSessionAudio, trackPath } from '../recorder'
import {
  editSession,
  readManifestOf,
  readSession,
  sessionRawDir,
  updateManifest
} from '../sessionStore'
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
  restorePerson,
  selfPerson,
  setSelf,
  type VoiceMatch
} from '../voices'
import { transcribePcm } from '../whisper'
import type { DiarizeResult, DiarizedSegment, SpeakerModels } from './protocol'
import { notifyLabeled } from './events'
import { sessionVoiceprints, type WrittenPass } from './voiceprints'
import { diarize, embedVoice, ensureSpeakerModels } from './speakers'
import { SPEAKER_EMBEDDING } from './speakerModel'
import { couldBeOnePerson, micShareOf, pickSelfSpeaker } from './speakerRules'
import {
  DIARIZE_THRESHOLD,
  LEARN_MARGIN,
  LEARN_MIN_SECONDS,
  MATCH_THRESHOLD,
  REINFORCE_THRESHOLD,
  SAME_PERSON_THRESHOLD,
  SELF_MIC_SHARE
} from './thresholds'
import { mixTracks, readWav } from './wav'

/** Merge a speaker's segments separated by less than this into one turn. */
const MERGE_GAP_SECONDS = 1
/** Whisper works on ≤30 s windows; keep turns comfortably under that. */
const MAX_TURN_SECONDS = 25
/** Below this much total speech, a "speaker" is folded into the closest real one. */
const MIN_SPEAKER_SECONDS = 2
const PROMPT_CHARS = 200
/** Saved voices kept per speaker, ranked, for the speaker picker. */
const MAX_MATCHES = 5
/** Lines shorter than this give too little audio for a meaningful voiceprint. */
const MIN_LINE_SECONDS = 1.5
/** Listen plays at most this much of a line. */
const MAX_LISTEN_SECONDS = 30
const ORIGIN_PIPELINE = 'pipeline'
/** Recorded in raw passes; matches the model `whisper.ts` downloads. */
const WHISPER_MODEL = 'whisper ggml-large-v3-turbo-q5_0'

type Turn = { start: number; end: number; speaker: number }
type NamedSpeaker = {
  id: string
  cluster: number
  name: string
  personId: string | null
  confidence: number | null
  matches: SpeakerMatch[]
  embedding: number[]
}

const speakerId = (cluster: number): string => `c${String(cluster)}`

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
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

/**
 * Merges speakers that are clearly the same saved person. Clustering sometimes splits one voice
 * in two (they moved, or spoke up); a saved voice anchors both halves, so they become one
 * speaker, the one closer to the saved voice. Only for strong matches: a weak one could be
 * someone who merely sounds similar. Never two speakers who talked over each other at length or
 * sit on opposite sides of a call, which one person can't: those are two people who sound alike.
 */
export async function mergeSamePerson(
  result: DiarizeResult,
  pageId: string,
  hasSystemTrack: boolean
): Promise<DiarizeResult> {
  const best = new Map<string, { speaker: number; score: number }>()
  const matched: { speaker: number; personId: string; score: number }[] = []
  for (const cluster of result.clusters) {
    const top = (await scoreVoices(cluster.embedding, pageId))[0]
    if (!top || top.score < SAME_PERSON_THRESHOLD) continue
    matched.push({ speaker: cluster.speaker, personId: top.person.id, score: top.score })
    const current = best.get(top.person.id)
    if (!current || top.score > current.score) best.set(top.person.id, { speaker: cluster.speaker, score: top.score })
  }
  const own = (speaker: number): DiarizedSegment[] => result.segments.filter((s) => s.speaker === speaker)
  const into = new Map<number, number>()
  let blocked = 0
  for (const { speaker, personId } of matched) {
    const keep = best.get(personId)
    if (!keep || keep.speaker === speaker) continue
    if (couldBeOnePerson(own(speaker), own(keep.speaker), hasSystemTrack)) into.set(speaker, keep.speaker)
    else blocked++
  }
  if (blocked) log('meeting', 'kept apart speakers matching one saved voice', { pageId, blocked })
  if (into.size === 0) return result
  log('meeting', 'merged speakers matching one saved voice', Object.fromEntries(into))
  return {
    ...result,
    segments: result.segments.map((s) => ({ ...s, speaker: into.get(s.speaker) ?? s.speaker })),
    clusters: result.clusters.filter((cluster) => !into.has(cluster.speaker))
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

/** A voice sample a pass would teach a saved person, once the pass is known to apply. */
export type LearnedSample = { personId: string; embedding: number[]; sessionId: string }

/** Teaches saved voices what a pass heard; call only after the pass was written to the session. */
export async function learnSamples(samples: readonly LearnedSample[]): Promise<void> {
  for (const { personId, embedding, sessionId } of samples) {
    await addSample(personId, embedding, { source: 'auto', sessionId, model: SPEAKER_EMBEDDING.model })
  }
}

/**
 * Names each cluster: a saved voice, else "you" when it's mostly the mic track, else Speaker N.
 * Also returns the samples confident matches would teach their saved voices; the caller applies
 * them with `learnSamples` once the names are in the session, so a pass that is thrown away
 * (the session changed meanwhile) teaches nothing.
 */
export async function nameSpeakers(
  result: DiarizeResult,
  context: { pageId: string; hasSystemTrack: boolean }
): Promise<{ speakers: NamedSpeaker[]; learn: LearnedSample[] }> {
  const { pageId, hasSystemTrack } = context
  const me = await selfPerson()
  const order = [...new Set([...result.segments].sort((a, b) => a.start - b.start).map((s) => s.speaker))]

  // Score every speaker against every saved voice, then hand out names best-first,
  // so each person labels one speaker and each speaker gets at most one name.
  const scored = await Promise.all(
    result.clusters.map(async (cluster) => ({
      speaker: cluster.speaker,
      embedding: cluster.embedding,
      scores: await scoreVoices(cluster.embedding, pageId)
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
      best: best ? { person: best.person.id, score: +best.score.toFixed(3) } : null,
      assigned: assigned.get(speaker)?.person.id ?? null
    })
  }
  // Confident matches teach the voiceprint, so it keeps up with mics and rooms. Only from a
  // speaker with plenty of speech whom no other speaker here comes close to: a wrong sample
  // would make the saved voice match the wrong person from then on.
  const talk = new Map<number, number>()
  for (const s of result.segments) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start)
  const learn: LearnedSample[] = []
  for (const { speaker, embedding } of scored) {
    const match = assigned.get(speaker)
    if (!match || match.score < REINFORCE_THRESHOLD || !embedding.length) continue
    const rival = Math.max(
      -Infinity,
      ...scored
        .filter((other) => other.speaker !== speaker)
        .map((other) => other.scores.find((entry) => entry.person.id === match.person.id)?.score ?? -Infinity)
    )
    if ((talk.get(speaker) ?? 0) < LEARN_MIN_SECONDS || match.score - rival < LEARN_MARGIN) {
      log('meeting', 'voice not learned', { speaker, person: match.person.id, seconds: +(talk.get(speaker) ?? 0).toFixed(1) })
      continue
    }
    learn.push({ personId: match.person.id, embedding, sessionId: pageId })
  }

  const selfName = me?.name ?? 'Me'
  // The mic-track hint can't override a voice match that already found "me".
  const selfSpeaker =
    hasSystemTrack && !(me && taken.has(me.id))
      ? pickSelfSpeaker(
          order
            .filter((speaker) => !assigned.has(speaker))
            .map((speaker) => {
              const own = result.segments.filter((segment) => segment.speaker === speaker)
              return { speaker, seconds: talk.get(speaker) ?? 0, micShare: micShareOf(own) }
            }),
          SELF_MIC_SHARE
        )
      : null
  let unknown = 0
  const speakers: NamedSpeaker[] = []
  for (const speaker of order) {
    const cluster = result.clusters.find((entry) => entry.speaker === speaker)
    const match = assigned.get(speaker)
    const matches = (scored.find((entry) => entry.speaker === speaker)?.scores ?? [])
      .slice(0, MAX_MATCHES)
      .map((entry) => ({ personId: entry.person.id, score: +entry.score.toFixed(3) }))

    let name: string
    let personId: string | null = null
    let confidence: number | null = null
    if (match) {
      name = match.person.name
      personId = match.person.id
      confidence = +match.score.toFixed(3)
    } else if (speaker === selfSpeaker) {
      name = selfName
      personId = me?.id ?? null
    } else {
      unknown++
      name = `Speaker ${String(unknown)}`
    }
    speakers.push({
      id: speakerId(speaker),
      cluster: speaker,
      name,
      personId,
      confidence,
      matches,
      embedding: cluster?.embedding ?? []
    })
  }
  return { speakers, learn }
}

type Line = { turn: Turn; words: TranscriptWord[]; text: string }

async function turnAudio(recording: MeetingRecording, turn: { start: number; end: number }): Promise<Float32Array> {
  const mic = await readWav(recording.micPath, turn.start, turn.end)
  const system = recording.systemPath ? await readWav(recording.systemPath, turn.start, turn.end) : null
  return mixTracks(mic, system)
}

async function transcribeTurns(
  recording: MeetingRecording,
  turns: Turn[],
  onProgress: (done: number) => void
): Promise<Line[]> {
  const lines: Line[] = []
  let context = ''
  for (const [index, turn] of turns.entries()) {
    const heard = await transcribePcm(await turnAudio(recording, turn), context.slice(-PROMPT_CHARS))
    onProgress(index + 1)
    const words = heard.map((word) => ({
      text: word.text,
      start: +(word.start + turn.start).toFixed(3),
      end: +(word.end + turn.start).toFixed(3)
    }))
    const text = words.map((word) => word.text).join('').trim()
    if (!text) continue
    context += ` ${text}`
    const previous = lines.at(-1)
    // Consecutive turns by the same speaker read better as one line.
    if (previous?.turn.speaker === turn.speaker) {
      previous.turn = { ...previous.turn, end: turn.end }
      previous.words.push(...words)
      previous.text = `${previous.text} ${text}`
    } else {
      lines.push({ turn: { ...turn }, words, text })
    }
  }
  return lines
}

/**
 * How much each line sounds like the rest of its speaker: the line's own voiceprint against
 * the speaker's. Low scores flag a line that may be someone else (the UI's "Split").
 */
async function lineConfidence(
  recording: MeetingRecording,
  lines: Line[],
  speakers: NamedSpeaker[],
  models: SpeakerModels
): Promise<(number | null)[]> {
  const out: (number | null)[] = []
  for (const line of lines) {
    const speaker = speakers.find((entry) => entry.cluster === line.turn.speaker)
    if (!speaker?.embedding.length || line.turn.end - line.turn.start < MIN_LINE_SECONDS) {
      out.push(null)
      continue
    }
    try {
      const embedding = await embedVoice(await turnAudio(recording, line.turn), models)
      out.push(+Math.max(0, Math.min(1, cosine(embedding, speaker.embedding))).toFixed(3))
    } catch (error) {
      log('meeting', 'line confidence failed', String(error))
      out.push(null)
    }
  }
  return out
}

export async function nextPassId(pageId: string): Promise<string> {
  const manifest = await readManifestOf(pageId)
  const n = manifest.passes.filter((pass) => pass.kind === 'diarized').length + 1
  return `pass-${String(n)}`
}

/** Labels a finished recording: diarize, name speakers, transcribe turns, fill the document. */
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
    threshold: DIARIZE_THRESHOLD,
    // Diarization comes first here, so there are no words yet.
    words: null
  })
  log('meeting', 'diarized', {
    pageId,
    speakers: result.clusters.length,
    segments: result.segments.length,
    rtf: +((Date.now() - started) / 1000 / Math.max(1, result.seconds)).toFixed(3)
  })

  const merged = await mergeSamePerson(mergeTinySpeakers(result), pageId, recording.systemPath !== null)
  // One voice: a dictation, not a conversation. It stays as notes; no transcript, no notes.
  if (merged.clusters.length < 2 && !(await readSession(pageId)).transcript.length) {
    if (getSettings().audioRetentionDays === 0) await deleteSessionAudio(pageId)
    status('done', 1)
    log('meeting', 'one voice; kept as notes', { pageId })
    return
  }
  const { speakers, learn } = await nameSpeakers(merged, { pageId, hasSystemTrack: recording.systemPath !== null })
  const turns = buildTurns(merged.segments)
  status('transcribing', 0)
  const lines = await transcribeTurns(recording, turns, (done) => {
    status('transcribing', done / Math.max(1, turns.length))
  })
  const confidence = await lineConfidence(recording, lines, speakers, models)

  const passId = await nextPassId(pageId)
  const segments: NewSegment[] = lines.map((line, index) => ({
    id: `${passId}-s${String(index)}`,
    rawId: `${passId}-s${String(index)}`,
    start: line.turn.start,
    end: line.turn.end,
    cluster: speakerId(line.turn.speaker),
    confidence: confidence[index] ?? null,
    text: line.text
  }))
  const pass: WrittenPass = {
    id: passId,
    kind: 'diarized',
    model: `sherpa-onnx diarization + ${WHISPER_MODEL}`,
    createdAt: new Date().toISOString(),
    segments: lines.map((line, index) => ({
      id: segments[index]?.id ?? '',
      start: line.turn.start,
      end: line.turn.end,
      track: recording.systemPath ? 'mix' : 'mic',
      cluster: speakerId(line.turn.speaker),
      confidence: confidence[index] ?? null,
      words: line.words
    })),
    clusters: speakers.map((speaker) => ({
      id: speaker.id,
      embedding: speaker.embedding,
      matches: speaker.matches,
      model: SPEAKER_EMBEDDING.model
    }))
  }
  await mkdir(sessionRawDir(pageId), { recursive: true })
  await writeFile(join(sessionRawDir(pageId), `${passId}.json`), JSON.stringify(pass), 'utf8')

  if (segments.length) {
    await editSession(pageId, (doc) => {
      doc.transact(() => {
        for (const speaker of speakers) {
          upsertSpeaker(doc, speaker.id, {
            name: speaker.name,
            personId: speaker.personId,
            // Only the user confirms. A strong match still shows as sure (`SURE_MATCH`), but
            // stays Lyra's guess, so a later pass can still correct it.
            confirmed: false,
            confidence: speaker.confidence,
            matches: speaker.matches
          }, ORIGIN_PIPELINE)
        }
        replaceTranscript(doc, segments, ORIGIN_PIPELINE)
        // The labeled transcript supersedes the rough live text of the same audio.
        removeLiveNotes(doc, ORIGIN_PIPELINE)
      }, ORIGIN_PIPELINE)
    })
    await learnSamples(learn)
  }
  await updateManifest(pageId, (manifest) => ({
    ...manifest,
    passes: [...manifest.passes, { id: passId, kind: 'diarized', createdAt: pass.createdAt, model: pass.model }]
  }))
  if (getSettings().audioRetentionDays === 0) await deleteSessionAudio(pageId)

  status('done', 1)
  log('meeting', 'labeled', { pageId, lines: segments.length, pass: passId })
  notifyLabeled(pageId)
}

/** The voiceprint of a speaker from the latest pass in which they own lines (`ownedVoiceprints`). */
async function speakerEmbedding(pageId: string, id: string): Promise<{ vector: number[]; model: string } | null> {
  return (await sessionVoiceprints(pageId)).get(id) ?? null
}

/**
 * Who a session's speaker is, teaching that voice the speaker's audio on the way. The caller
 * writes the name into the session (`assignSpeaker` here; the window, so it can undo it).
 */
export async function resolveSpeaker(
  pageId: string,
  id: string,
  assignment: SpeakerAssignment
): Promise<SpeakerIdentity> {
  const speaker = (await readSession(pageId)).speakers.find((entry) => entry.id === id)
  if (!speaker) throw new Error('This session has no such speaker')
  const print = await speakerEmbedding(pageId, id)
  // The user said who this is: a sample they vouch for, from this session.
  const origin = { source: 'user', sessionId: pageId, model: print?.model ?? SPEAKER_EMBEDDING.model } as const

  let name: string
  let personId: string | null
  if ('personId' in assignment) {
    const person = await getPerson(assignment.personId)
    if (!person) throw new Error('That person no longer exists')
    name = person.name
    personId = person.id
    // Teach the voiceprint this sample, so the person is recognized next time.
    if (print) await addSample(person.id, print.vector, origin)
  } else {
    name = assignment.name.trim()
    if (!name) throw new Error('A name is required')
    // A saved voice with this name already: that's who this is, not a second "Dillon".
    const known = (await listPeople()).find(
      (person) => person.name.trim().toLowerCase() === name.toLowerCase()
    )
    personId = known?.id ?? null
    if (known) {
      name = known.name
      if (print) await addSample(known.id, print.vector, origin)
    } else if (assignment.remember && print) {
      personId = (await addPerson(name, print.vector, false, origin)).id
    }
  }
  return { name, personId }
}

/** Names a session's speaker and writes it into the session, merging with a same-named one. */
export async function assignSpeaker(
  pageId: string,
  id: string,
  assignment: SpeakerAssignment
): Promise<void> {
  const { name, personId } = await resolveSpeaker(pageId, id, assignment)
  const merged = await editSession(pageId, (doc) => {
    const into = speakerToMergeInto(doc, id, name, personId)
    doc.transact(() => {
      if (into) {
        // Naming two speakers the same person merges them.
        upsertSpeaker(doc, into, { name, personId, confirmed: true }, ORIGIN_PIPELINE)
        mergeSpeakers(doc, id, into, ORIGIN_PIPELINE)
      } else {
        upsertSpeaker(doc, id, { name, personId, confirmed: true }, ORIGIN_PIPELINE)
      }
    }, ORIGIN_PIPELINE)
    return into
  })
  log('meeting', 'named speaker', {
    pageId,
    speaker: id,
    mergedInto: merged,
    remembered: personId !== null
  })
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

/** Mixed audio for a stretch of a session, as 16-bit PCM for playback (Listen). */
export async function sessionAudio(pageId: string, start: number, end: number): Promise<Int16Array> {
  const span = Math.min(Math.max(0, end - start), MAX_LISTEN_SECONDS)
  const micPath = trackPath(pageId, 'mic')
  if (!existsSync(micPath) || span <= 0) return new Int16Array(0)
  const systemPath = trackPath(pageId, 'system')
  const mixed = await turnAudio(
    { pageId, micPath, systemPath: existsSync(systemPath) ? systemPath : null, seconds: 0 },
    { start, end: start + span }
  )
  const out = new Int16Array(mixed.length)
  for (let i = 0; i < mixed.length; i++) {
    const value = Math.max(-1, Math.min(1, mixed[i] ?? 0))
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return out
}

/** Line audio past this adds little to a voiceprint and slows the comparison down. */
const MAX_LINE_PRINT_SECONDS = 10
/**
 * A line moves with a correction only when it sounds closer to the lines the user moved than to
 * the lines they left, by this much. Per-line voiceprints are a few seconds each, so noisier than
 * a speaker's; the margin keeps a line that could go either way where it is.
 */
const FOLLOW_MARGIN = 0.1

function centroid(vectors: readonly number[][]): number[] {
  const first = vectors[0]
  if (!first) return []
  return first.map((_, i) => vectors.reduce((sum, vector) => sum + (vector[i] ?? 0), 0) / vectors.length)
}

/**
 * After the user moves some of a speaker's lines to another speaker, the rest of that speaker's
 * lines that sound like the moved ones: one correction ("this line is me") then fixes every line
 * the clustering got wrong the same way. The renderer offers to move them; nothing moves here.
 */
export async function similarLines(pageId: string, moved: readonly string[], from: string): Promise<string[]> {
  const micPath = trackPath(pageId, 'mic')
  if (!existsSync(micPath)) return []
  const systemPath = trackPath(pageId, 'system')
  const recording = { pageId, micPath, systemPath: existsSync(systemPath) ? systemPath : null, seconds: 0 }
  const session = await readSession(pageId)
  const long = (line: { start: number; end: number }): boolean => line.end - line.start >= MIN_LINE_SECONDS
  const movedLines = session.transcript.filter((line) => moved.includes(line.id) && long(line))
  const staying = session.transcript.filter((line) => line.cluster === from && !moved.includes(line.id) && long(line))
  if (movedLines.length === 0 || staying.length < 2) return []
  const models = await ensureSpeakerModels()
  const print = async (line: { start: number; end: number }): Promise<number[]> =>
    embedVoice(await turnAudio(recording, { start: line.start, end: Math.min(line.end, line.start + MAX_LINE_PRINT_SECONDS) }), models)
  const movedPrint = centroid(await Promise.all(movedLines.map(print)))
  const prints = await Promise.all(staying.map(print))
  const out: string[] = []
  staying.forEach((line, i) => {
    const own = prints[i] ?? []
    // The speaker's voice without this line, so a line isn't compared with itself.
    const rest = centroid(prints.filter((_, k) => k !== i))
    if (cosine(own, movedPrint) >= cosine(own, rest) + FOLLOW_MARGIN) out.push(line.id)
  })
  log('meeting', 'similar lines', { pageId, moved: movedLines.length, checked: staying.length, similar: out.length })
  return out
}

/**
 * Speakers are settled after each recording (`relabel.ts`). `processMeeting` labels a whole
 * recording at once with offline diarization, for the meeting smoke test and eval.
 */
export function registerMeetingPipeline(): void {
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
    if (typeof id !== 'string' && id !== null) throw new Error('Invalid input')
    return setSelf(id)
  })
  ipcMain.handle('people:delete', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid input')
    return deletePerson(id)
  })
  ipcMain.handle('people:restore', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid input')
    return restorePerson(id)
  })
  ipcMain.handle(
    'meeting:resolveSpeaker',
    (_event, pageId: unknown, id: unknown, assignment: unknown) => {
      if (typeof pageId !== 'string' || typeof id !== 'string') throw new Error('Invalid input')
      return resolveSpeaker(pageId, id, parseAssignment(assignment))
    }
  )
  ipcMain.handle('meeting:similarLines', (_event, pageId: unknown, moved: unknown, from: unknown) => {
    if (
      typeof pageId !== 'string' ||
      typeof from !== 'string' ||
      !Array.isArray(moved) ||
      !moved.every((id) => typeof id === 'string')
    ) {
      throw new Error('Invalid input')
    }
    resolveInNotes(pageId)
    return similarLines(pageId, moved, from)
  })
  ipcMain.handle('sessions:audio', (_event, pageId: unknown, start: unknown, end: unknown) => {
    if (typeof pageId !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
      throw new Error('Invalid input')
    }
    resolveInNotes(pageId)
    return sessionAudio(pageId, start, end)
  })
}

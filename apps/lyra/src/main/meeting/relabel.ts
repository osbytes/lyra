import { BrowserWindow } from 'electron'
import type * as Y from 'yjs'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MeetingStatus, TranscriptWord } from '../../shared/types'
import {
  newSpeakerId,
  removeSpeaker,
  renumberSpeakers,
  replaceTranscript,
  snapshotOf,
  speakersOf,
  upsertSpeaker,
  type NewSegment,
  type SpeakerEntry
} from '../../shared/sessionDoc'
import { log } from '../log'
import { deleteSessionAudio, recordingPageId, trackPath } from '../recorder'
import { editSession, readSession, sessionRawDir, updateManifest } from '../sessionStore'
import { getSettings } from '../settings'
import { notifyLabeled } from './events'
import { changedLabels, noteSettled } from './labelChanges'
import { learnSamples, mergeSamePerson, mergeTinySpeakers, nameSpeakers, nextPassId } from './pipeline'
import type { DiarizedSegment } from './protocol'
import { audioSeconds, diarize, ensureSpeakerModels } from './speakers'
import { startEstimate } from './estimate'
import { MIC_SIDE } from './clustering'
import { SPEAKER_EMBEDDING } from './speakerModel'
import { movedLines, pinnedSpeakers } from './speakerRules'
import { DIARIZE_THRESHOLD } from './thresholds'
import { passClusters, type WrittenPass } from './voiceprints'

/**
 * Speaker labels settled once a recording stops. The track a line was heard on can't tell apart
 * two people at one mic or on one call, so only the voices say who spoke. With the whole
 * recording in hand, offline diarization (pyannote segmentation, then
 * TitaNet voiceprints of 3 s windows clustered over every stretch at once; `clustering.ts`)
 * separates them (the same is done every half minute while recording, on what has been heard
 * so far: `liveLabels.ts`), and a saved voice that matches two speakers strongly merges them
 * (`mergeSamePerson`). Each word then goes to the speaker diarized at its time, as WhisperX does,
 * keeping to speakers heard on its own track: the text stays word for word, only who said it and
 * where lines break change. Lines the user edited keep their text, and words in a line the user
 * moved to another speaker stay with that speaker.
 */

/** A word with no diarized speech under it takes the nearest speaker within this many seconds. */
const NEAREST_SECONDS = 1
/** Same as live lines: one line per turn, up to MAX_LINE_SECONDS. */
const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
const ORIGIN_RELABEL = 'relabel'
const MODEL = 'sherpa-onnx diarization over live words'

/** `pinned`: the speaker the user moved these words to, which outranks the diarized `speaker`. */
export type Line = { speaker: number; pinned: string | null; words: TranscriptWord[] }

/** A word and the track it was transcribed from, when the recording kept them apart. */
export type HeardWord = TranscriptWord & { track: 'mic' | 'system' | null }

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * The diarized speaker of each word: most overlap, else the nearest close by, else the one before.
 * A word heard on the mic track only goes to a speaker who is mostly on the mic, and a system-track
 * word to one who isn't, when there is such a speaker nearby: on speakers the far end also reaches
 * the mic, so the diarized turns blur at the edges, but the track a word came from doesn't.
 */
export function assignWords(words: readonly HeardWord[], segments: readonly DiarizedSegment[]): number[] {
  const out: number[] = []
  for (const word of words) {
    const side = sideSegments(word.track, segments)
    out.push(nearestSpeaker(word, side) ?? nearestSpeaker(word, segments) ?? out.at(-1) ?? segments[0]?.speaker ?? 0)
  }
  return out
}

function sideSegments(track: HeardWord['track'], segments: readonly DiarizedSegment[]): readonly DiarizedSegment[] {
  if (track === 'mic') return segments.filter((segment) => segment.micShare >= MIC_SIDE)
  if (track === 'system') return segments.filter((segment) => segment.micShare < MIC_SIDE)
  return segments
}

function nearestSpeaker(word: TranscriptWord, segments: readonly DiarizedSegment[]): number | null {
  let speaker: number | null = null
  let best = 0
  for (const segment of segments) {
    const shared = overlap(word, segment)
    if (shared > best) {
      best = shared
      speaker = segment.speaker
    }
  }
  if (speaker === null) {
    const middle = (word.start + word.end) / 2
    let nearest = NEAREST_SECONDS
    for (const segment of segments) {
      const distance = Math.max(segment.start - middle, middle - segment.end)
      if (distance < nearest) {
        nearest = distance
        speaker = segment.speaker
      }
    }
  }
  return speaker
}

/**
 * Groups words into lines: a new line when the speaker (or the speaker the user pinned) changes,
 * after a long pause, or past MAX_LINE_SECONDS.
 */
export function buildLines(
  words: readonly TranscriptWord[],
  speakers: readonly number[],
  pins: readonly (string | null)[] = []
): Line[] {
  const lines: Line[] = []
  words.forEach((word, index) => {
    const speaker = speakers[index] ?? 0
    const pinned = pins[index] ?? null
    const line = lines.at(-1)
    const first = line?.words[0]
    const last = line?.words.at(-1)
    if (
      line?.speaker === speaker &&
      line.pinned === pinned &&
      first &&
      last &&
      word.start - last.end <= LINE_JOIN_GAP &&
      word.end - first.start <= MAX_LINE_SECONDS
    ) {
      line.words.push(word)
    } else {
      lines.push({ speaker, pinned, words: [word] })
    }
  })
  return lines
}

const Word = z.object({ text: z.string(), start: z.number(), end: z.number() })
const Segment = z.object({
  start: z.number(),
  track: z.enum(['mic', 'system', 'mix']).catch('mix'),
  words: z.array(z.unknown())
})
const LivePass = z.object({ segments: z.array(z.unknown()) })

/**
 * Every word transcribed while recording, in time order. Each chunk's words stay in the order
 * Whisper gave them; chunks are ordered by where they start, across both tracks.
 */
export async function liveWords(pageId: string): Promise<HeardWord[]> {
  const path = join(sessionRawDir(pageId), 'live.json')
  if (!existsSync(path)) return []
  const pass = LivePass.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!pass.success) return []
  const segments = pass.data.segments.flatMap((entry) => {
    const segment = Segment.safeParse(entry)
    return segment.success ? [segment.data] : []
  })
  return segments
    .sort((a, b) => a.start - b.start)
    .flatMap((segment) => {
      const track = segment.track === 'mix' ? null : segment.track
      return segment.words.flatMap((entry) => {
        const word = Word.safeParse(entry)
        return word.success ? [{ ...word.data, track }] : []
      })
    })
}

/**
 * Which existing speaker each diarized one continues: the pairs that share the most talk, one to
 * one, so a name the user gave while recording stays with the person who mostly had it.
 */
export function matchSpeakers(
  lines: readonly Line[],
  before: readonly { start: number; end: number; cluster: string | null }[]
): Map<number, string> {
  const shared = new Map<string, number>()
  for (const line of lines) {
    const span = { start: line.words[0]?.start ?? 0, end: line.words.at(-1)?.end ?? 0 }
    for (const old of before) {
      if (!old.cluster) continue
      const key = `${String(line.speaker)} ${old.cluster}`
      shared.set(key, (shared.get(key) ?? 0) + overlap(span, old))
    }
  }
  const pairs = [...shared.entries()]
    .filter(([, seconds]) => seconds > 0)
    .sort((a, b) => b[1] - a[1])
  const out = new Map<number, string>()
  const taken = new Set<string>()
  for (const [key] of pairs) {
    const [speaker = '', id = ''] = key.split(' ')
    const cluster = Number(speaker)
    if (out.has(cluster) || taken.has(id)) continue
    out.set(cluster, id)
    taken.add(id)
  }
  return out
}

type NamedVoice = Awaited<ReturnType<typeof nameSpeakers>>['speakers'][number]

/** What `writeLines` put in the session: each diarized speaker's id, its entry, and the lines. */
export type WrittenLines = {
  idOf: Map<number, string>
  fields: Map<string, Omit<SpeakerEntry, 'id'>>
  segments: NewSegment[]
}

/**
 * Writes a pass's speakers and lines into the session, in one transaction: each diarized speaker
 * carries on the session speaker it `continues` (or gets a new one), lines the user pinned keep
 * their speaker, and speakers nobody speaks as any more go. A line whose speaker isn't among
 * `named` (words not yet settled while recording) is written with none.
 */
export function writeLines(
  doc: Y.Doc,
  pass: {
    /** The session's speakers before the pass. */
    known: readonly SpeakerEntry[]
    named: readonly NamedVoice[]
    continues: ReadonlyMap<number, string>
    lines: readonly Line[]
    lineId: (index: number, line: Line) => string
    /** Whether the lines are a raw pass of their own (kept in `raw/`), found by the same id. */
    raw: boolean
  }
): WrittenLines {
  const idOf = new Map<number, string>()
  const fields = new Map<string, Omit<SpeakerEntry, 'id'>>()
  let segments: NewSegment[] = []
  doc.transact(() => {
    const old = new Map(pass.known.map((speaker) => [speaker.id, speaker]))
    for (const speaker of pass.named) {
      const id = pass.continues.get(speaker.cluster) ?? null
      const kept = id ? old.get(id) : undefined
      const fresh = id ?? newSpeakerId(doc)
      idOf.set(speaker.cluster, fresh)
      // The user's name for a voice outranks Lyra's guess at it. A guess is never confirmed,
      // however strong the match (it still shows as sure): confirmed speakers are kept as is
      // by every later pass, so a wrong guess would stick.
      const entry = kept?.confirmed
        ? { ...kept, matches: speaker.matches }
        : {
            name: speaker.name,
            personId: speaker.personId,
            confirmed: false,
            confidence: speaker.confidence,
            matches: speaker.matches
          }
      fields.set(fresh, entry)
      // Written now so the next newSpeakerId doesn't hand the id out again.
      upsertSpeaker(doc, fresh, entry, ORIGIN_RELABEL)
    }
    const map = speakersOf(doc)
    segments = pass.lines.map((line, index) => {
      // A speaker the user moved words to, unless they've since removed that speaker.
      const pinned = line.pinned !== null && map?.has(line.pinned) === true ? line.pinned : null
      const id = pass.lineId(index, line)
      return {
        id,
        rawId: pass.raw ? id : null,
        start: line.words[0]?.start ?? 0,
        end: line.words.at(-1)?.end ?? 0,
        cluster: pinned ?? idOf.get(line.speaker) ?? null,
        // Still the user's choice, so the pass after this one keeps it too.
        userCluster: pinned !== null,
        confidence: null,
        text: line.words.map((word) => word.text).join('').trim()
      }
    })
    replaceTranscript(doc, segments, ORIGIN_RELABEL)
    // Voices nobody speaks as any more. Read from the document: a line can keep the speaker the
    // user chose for the old line under it (`replaceTranscript`), not the one written here.
    const shown = snapshotOf(doc).transcript.flatMap((line) => line.cluster ?? [])
    const used = new Set([...fields.keys(), ...shown])
    for (const id of [...(map?.keys() ?? [])]) if (!used.has(id)) removeSpeaker(doc, id, ORIGIN_RELABEL)
    renumberSpeakers(doc, ORIGIN_RELABEL)
  }, ORIGIN_RELABEL)
  return { idOf, fields, segments }
}

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

const running = new Map<string, Promise<void>>()

/** Whether any session's speakers are being settled right now. */
export function isRelabeling(): boolean {
  return running.size > 0
}

/** Settles a session's speakers after a recording; one run per session at a time. */
export function relabelSession(pageId: string): Promise<void> {
  const previous = running.get(pageId) ?? Promise.resolve()
  let finished = false
  const next = previous
    .then(() => relabel(pageId))
    .then(() => {
      finished = true
    })
    .catch((error: unknown) => {
      log('relabel', 'failed', { pageId, error: error instanceof Error ? error.message : String(error) })
      broadcast({ pageId, task: 'speakers', state: 'error', progress: 0, message: error instanceof Error ? error.message : String(error) })
    })
    .finally(async () => {
      if (running.get(pageId) === next) running.delete(pageId)
      if (getSettings().audioRetentionDays !== 0 || recordingPageId() === pageId) return
      // "Keep recordings until transcribed": this was the last step that needed the audio. A
      // failed run (a model download, a worker crash) keeps it: it's the only copy, and the next
      // take relabels the whole session again.
      if (finished) await deleteSessionAudio(pageId)
      else log('relabel', 'kept audio after a failed relabel', { pageId })
    })
  running.set(pageId, next)
  return next
}

/** Resolves once any relabeling of `pageId` has finished (fixtures wait on this). */
export function relabeled(pageId: string): Promise<void> {
  return running.get(pageId) ?? Promise.resolve()
}

async function relabel(pageId: string): Promise<void> {
  const micPath = trackPath(pageId, 'mic')
  if (!existsSync(micPath)) return
  const systemFile = trackPath(pageId, 'system')
  const systemPath = existsSync(systemFile) ? systemFile : null
  const words = await liveWords(pageId)
  if (!words.length) return
  const before = await readSession(pageId)
  const started = Date.now()

  const models = await ensureSpeakerModels()
  const timing = startEstimate(await audioSeconds([micPath, systemPath]))
  broadcast({ pageId, task: 'speakers', state: 'diarizing', progress: 0, estimate: timing.estimate })
  const result = await mergeSamePerson(
    mergeTinySpeakers(
      await diarize({
        micPath,
        systemPath,
        models,
        threshold: DIARIZE_THRESHOLD,
        words: words.map(({ start, end }) => ({ start, end }))
      })
    ),
    pageId,
    systemPath !== null
  )
  // Lines whose speaker the user chose (marked, or moved since an earlier pass): their words keep
  // that speaker, live lines from a take never relabeled included.
  const moved = movedLines(before.transcript, await passClusters(pageId))
  const pins = pinnedSpeakers(words, moved)
  const speakers = assignWords(words, result.segments)
  const lines = buildLines(words, speakers, pins)
  // Diarized speakers left with words of their own; one whose words were all moved isn't named.
  const voices = new Set(speakers.filter((_, index) => pins[index] === null))
  const liveVoices = new Set(before.transcript.flatMap((line) => (line.cluster ? [line.cluster] : [])))
  log('relabel', 'diarized', {
    pageId,
    liveSpeakers: liveVoices.size,
    speakers: voices.size,
    words: words.length,
    lines: lines.length,
    seconds: +((Date.now() - started) / 1000).toFixed(1)
  })

  const ids = (transcript: readonly { id: string }[]): string => transcript.map((line) => line.id).join(',')
  const stale = (transcript: readonly { id: string }[]): boolean =>
    recordingPageId() === pageId || ids(transcript) !== ids(before.transcript)
  // Bail before naming the voices, which takes a while.
  if (stale((await readSession(pageId)).transcript)) {
    log('relabel', 'session changed while diarizing; left as is', { pageId })
    broadcast({ pageId, task: 'speakers', state: 'done', progress: 1 })
    return
  }

  // Moved lines say who the user chose, not which diarized speaker continues whom.
  const movedIds = new Set(moved.map((line) => line.id))
  const continues = matchSpeakers(
    lines.filter((line) => line.pinned === null),
    before.transcript.filter((line) => !movedIds.has(line.id))
  )
  const { speakers: named, learn } = await nameSpeakers(
    { ...result, clusters: result.clusters.filter((cluster) => voices.has(cluster.speaker)) },
    { pageId, hasSystemTrack: systemPath !== null }
  )
  const passId = await nextPassId(pageId)

  // One edit, checked inside it: a recording started on this session meanwhile, or its lines
  // changed, makes this pass stale. Checking earlier left a gap (naming the voices takes a while)
  // in which a new take's lines could be replaced and their speaker removed under them.
  const written = await editSession(pageId, (doc) =>
    stale(snapshotOf(doc).transcript)
      ? null
      : writeLines(doc, {
          known: before.speakers,
          named,
          continues,
          lines,
          lineId: (index) => `${passId}-s${String(index)}`,
          raw: true
        })
  )
  if (!written) {
    log('relabel', 'session changed while diarizing; left as is', { pageId })
    broadcast({ pageId, task: 'speakers', state: 'done', progress: 1 })
    return
  }
  // Only now that the pass is in the session may it teach saved voices.
  await learnSamples(learn)
  const { idOf, fields, segments } = written

  const pass: WrittenPass = {
    id: passId,
    kind: 'diarized',
    model: MODEL,
    createdAt: new Date().toISOString(),
    segments: segments.map((segment, index) => {
      const line = lines[index]
      return {
        id: segment.id,
        start: segment.start,
        end: segment.end,
        track: systemPath ? 'mix' : 'mic',
        // What diarization said, even where the user's choice outranked it: a line whose speaker
        // differs from its pass's is how the next pass knows the user moved it.
        cluster: line?.pinned ? (idOf.get(line.speaker) ?? null) : segment.cluster,
        confidence: null,
        words: line?.words ?? []
      }
    }),
    clusters: named.map((speaker) => ({
      id: idOf.get(speaker.cluster) ?? speaker.id,
      embedding: speaker.embedding,
      matches: speaker.matches,
      model: SPEAKER_EMBEDDING.model
    }))
  }
  await mkdir(sessionRawDir(pageId), { recursive: true })
  await writeFile(join(sessionRawDir(pageId), `${passId}.json`), JSON.stringify(pass), 'utf8')

  await updateManifest(pageId, (manifest) => ({
    ...manifest,
    passes: [...manifest.passes, { id: passId, kind: 'diarized', createdAt: pass.createdAt, model: pass.model }]
  }))
  timing.finish()
  broadcast({ pageId, task: 'speakers', state: 'done', progress: 1 })
  // How much of what was labeled while recording this pass changed (`labelChanges.ts`).
  const stability = changedLabels(before.transcript, segments)
  noteSettled(pageId, stability.labeled, stability.changed)
  log('relabel', 'labeled', {
    pageId,
    pass: passId,
    speakers: fields.size,
    lines: segments.length,
    liveLabeledSeconds: +stability.labeled.toFixed(1),
    changedSeconds: +stability.changed.toFixed(1)
  })
  if (fields.size >= 2) notifyLabeled(pageId)
}

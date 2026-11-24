import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MeetingStatus, TranscriptWord } from '../../shared/types'
import {
  newSpeakerId,
  renumberSpeakers,
  replaceTranscript,
  snapshotOf,
  speakersOf,
  SURE_MATCH,
  upsertSpeaker,
  type NewSegment,
  type SpeakerEntry
} from '../../shared/sessionDoc'
import { log } from '../log'
import { deleteSessionAudio, recordingPageId, trackPath } from '../recorder'
import { editSession, readSession, sessionRawDir, updateManifest, type RawPass } from '../sessionStore'
import { getSettings } from '../settings'
import { notifyLabeled } from './events'
import { mergeSamePerson, mergeTinySpeakers, nameSpeakers, nextPassId } from './pipeline'
import type { DiarizedSegment } from './protocol'
import { diarize, ensureSpeakerModels } from './speakers'
import { DIARIZE_THRESHOLD } from './thresholds'

/**
 * Speaker labels settled once a recording stops. While recording, lines are labeled only by the
 * track they were heard on (`takeWriter.ts`), which can't tell apart two people at one mic or on
 * one call. With the whole recording in hand, offline diarization (pyannote segmentation, then
 * TitaNet voiceprints of 3 s windows clustered over every stretch at once; `clustering.ts`)
 * separates them, and a saved voice that matches two speakers strongly merges them
 * (`mergeSamePerson`). Each word then goes to the speaker diarized at its time, as WhisperX does,
 * keeping to speakers heard on its own track: the text stays word for word, only who said it and
 * where lines break change. Lines the user edited keep their text.
 */

/** A word with no diarized speech under it takes the nearest speaker within this many seconds. */
const NEAREST_SECONDS = 1
/** A diarized speaker with at least this share of their energy on the mic is at this computer. */
const MIC_SIDE = 0.5
/** Same as live lines: one line per turn, up to MAX_LINE_SECONDS. */
const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
const ORIGIN_RELABEL = 'relabel'
const MODEL = 'sherpa-onnx diarization over live words'

type Line = { speaker: number; words: TranscriptWord[] }

/** A word and the track it was transcribed from, when the recording kept them apart. */
type HeardWord = TranscriptWord & { track: 'mic' | 'system' | null }

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

/** Groups words into lines: a new line when the speaker changes, after a long pause, or past MAX_LINE_SECONDS. */
export function buildLines(words: readonly TranscriptWord[], speakers: readonly number[]): Line[] {
  const lines: Line[] = []
  words.forEach((word, index) => {
    const speaker = speakers[index] ?? 0
    const line = lines.at(-1)
    const first = line?.words[0]
    const last = line?.words.at(-1)
    if (
      line?.speaker === speaker &&
      first &&
      last &&
      word.start - last.end <= LINE_JOIN_GAP &&
      word.end - first.start <= MAX_LINE_SECONDS
    ) {
      line.words.push(word)
    } else {
      lines.push({ speaker, words: [word] })
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
async function liveWords(pageId: string): Promise<HeardWord[]> {
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
function matchSpeakers(
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

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

const running = new Map<string, Promise<void>>()

/** Settles a session's speakers after a recording; one run per session at a time. */
export function relabelSession(pageId: string): Promise<void> {
  const previous = running.get(pageId) ?? Promise.resolve()
  const next = previous
    .then(() => relabel(pageId))
    .catch((error: unknown) => {
      log('relabel', 'failed', { pageId, error: error instanceof Error ? error.message : String(error) })
      broadcast({ pageId, state: 'error', progress: 0, message: error instanceof Error ? error.message : String(error) })
    })
    .finally(async () => {
      if (running.get(pageId) === next) running.delete(pageId)
      // "Keep recordings until transcribed": this was the last step that needed the audio.
      if (getSettings().audioRetentionDays === 0 && recordingPageId() !== pageId) await deleteSessionAudio(pageId)
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
  broadcast({ pageId, state: 'diarizing', progress: 0 })
  const result = await mergeSamePerson(
    mergeTinySpeakers(await diarize({ micPath, systemPath, models, threshold: DIARIZE_THRESHOLD }))
  )
  const speakers = assignWords(words, result.segments)
  const lines = buildLines(words, speakers)
  const voices = new Set(speakers)
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
  // Bail before naming the voices, which also teaches saved voiceprints from this pass.
  if (stale((await readSession(pageId)).transcript)) {
    log('relabel', 'session changed while diarizing; left as is', { pageId })
    broadcast({ pageId, state: 'done', progress: 1 })
    return
  }

  const continues = matchSpeakers(lines, before.transcript)
  const named = await nameSpeakers(
    { ...result, clusters: result.clusters.filter((cluster) => voices.has(cluster.speaker)) },
    systemPath !== null
  )
  const passId = await nextPassId(pageId)
  const idOf = new Map<number, string>()
  const fields = new Map<string, Omit<SpeakerEntry, 'id'>>()
  let segments: NewSegment[] = []

  // One edit, checked inside it: a recording started on this session meanwhile, or its lines
  // changed, makes this pass stale. Checking earlier left a gap (naming the voices takes a while)
  // in which a new take's lines could be replaced and their speaker removed under them.
  const applied = await editSession(pageId, (doc) => {
    if (stale(snapshotOf(doc).transcript)) return false
    doc.transact(() => {
      const old = new Map(before.speakers.map((speaker) => [speaker.id, speaker]))
      for (const speaker of named) {
        const id = continues.get(speaker.cluster) ?? null
        const kept = id ? old.get(id) : undefined
        const fresh = id ?? newSpeakerId(doc)
        idOf.set(speaker.cluster, fresh)
        // The user's name for a voice outranks Lyra's guess at it.
        const entry = kept?.confirmed
          ? { ...kept, matches: speaker.matches }
          : {
              name: speaker.name,
              personId: speaker.personId,
              confirmed: (speaker.confidence ?? 0) >= SURE_MATCH,
              confidence: speaker.confidence,
              matches: speaker.matches
            }
        fields.set(fresh, entry)
        // Written now so the next newSpeakerId doesn't hand the id out again.
        upsertSpeaker(doc, fresh, entry, ORIGIN_RELABEL)
      }
      segments = lines.map((line, index) => ({
        id: `${passId}-s${String(index)}`,
        rawId: `${passId}-s${String(index)}`,
        start: line.words[0]?.start ?? 0,
        end: line.words.at(-1)?.end ?? 0,
        cluster: idOf.get(line.speaker) ?? null,
        confidence: null,
        text: line.words.map((word) => word.text).join('').trim()
      }))
      replaceTranscript(doc, segments, ORIGIN_RELABEL)
      // Voices nobody speaks as any more.
      const used = new Set(fields.keys())
      const map = speakersOf(doc)
      for (const id of [...(map?.keys() ?? [])]) if (!used.has(id)) map?.delete(id)
      renumberSpeakers(doc, ORIGIN_RELABEL)
    }, ORIGIN_RELABEL)
    return true
  })
  if (!applied) {
    log('relabel', 'session changed while diarizing; left as is', { pageId })
    broadcast({ pageId, state: 'done', progress: 1 })
    return
  }

  const pass: RawPass = {
    id: passId,
    kind: 'diarized',
    model: MODEL,
    createdAt: new Date().toISOString(),
    segments: segments.map((segment, index) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      track: systemPath ? 'mix' : 'mic',
      cluster: segment.cluster,
      confidence: null,
      words: lines[index]?.words ?? []
    })),
    clusters: named.map((speaker) => ({
      id: idOf.get(speaker.cluster) ?? speaker.id,
      embedding: speaker.embedding,
      matches: speaker.matches
    }))
  }
  await mkdir(sessionRawDir(pageId), { recursive: true })
  await writeFile(join(sessionRawDir(pageId), `${passId}.json`), JSON.stringify(pass), 'utf8')

  await updateManifest(pageId, (manifest) => ({
    ...manifest,
    passes: [...manifest.passes, { id: passId, kind: 'diarized', createdAt: pass.createdAt, model: pass.model }]
  }))
  broadcast({ pageId, state: 'done', progress: 1 })
  log('relabel', 'labeled', { pageId, pass: passId, speakers: fields.size, lines: segments.length })
  if (fields.size >= 2) notifyLabeled(pageId)
}

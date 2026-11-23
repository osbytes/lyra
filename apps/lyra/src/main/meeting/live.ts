import { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioTrack, MeetingStatus, TranscriptWord } from '../../shared/types'
import {
  appendLiveSegment,
  joinSplitLines,
  markPlaced,
  mergeSpeakers,
  renumberSpeakers,
  ORIGIN_TRANSCRIBER,
  snapshotOf,
  startTranscriber,
  SURE_MATCH,
  upsertSpeaker,
  type SpeakerMatch
} from '../../shared/sessionDoc'
import { log } from '../log'
import { changeSession, readManifestOf, sessionRawDir, type LiveTraceEvent } from '../sessionStore'
import { addSample, cosine, scoreVoices, selfPerson } from '../voices'
import type { SpeakerModels } from './protocol'
import { embedVoice, ensureSpeakerModels } from './speakers'
import { MATCH_THRESHOLD, REINFORCE_THRESHOLD, SELF_MIC_SHARE } from './thresholds'
import { energy, mixTracks, SAMPLE_RATE } from './wav'

/**
 * Speaker identification while recording. Each phrase the live transcriber commits is
 * voiceprinted from the audio just captured, clustered online against the voices heard so far,
 * and written as a transcript line for its speaker. Lines only ever grow at the end, so nothing
 * on the page moves; with one voice the window shows them as plain paragraphs. These labels are
 * provisional: once the recording stops, `relabel.ts` settles them from the whole recording.
 */

/** Audio kept in memory per track, enough for any phrase the transcriber commits late. */
const KEEP_SECONDS = 90
/**
 * A phrase this short ("Great.", "Yes.") has too little audio to tell who said it. When it opens
 * a sentence it often opens a new turn, so it waits for the next phrase and takes that phrase's
 * speaker when it follows within SAME_TURN_GAP; otherwise it stays with the speaker before. The
 * window keeps drawing it as unconfirmed text while it waits.
 */
const SHORT_PHRASE_SECONDS = 0.8
const SAME_TURN_GAP = 2
/** Cosine similarity needed to join a voice heard earlier in the session. */
const JOIN_THRESHOLD = 0.5
/**
 * Two voices whose running voiceprints grow this alike are one person: a short clip scored
 * under JOIN_THRESHOLD and started a phantom speaker. Two people settle around 0.5–0.6 with this
 * model; one person split in two lands around 0.75.
 */
const SAME_VOICE_THRESHOLD = 0.68
/** A voice with less speech than this by the end of a take folds into the closest one. */
const MIN_SPEAKER_SECONDS = 2
/** Lines shorter than this give too little audio for a meaningful line confidence. */
const MIN_LINE_SECONDS = 1.5
/**
 * One transcript line per turn: the same speaker continuing within this gap, with nobody
 * speaking in between, up to MAX_LINE_SECONDS. Whisper's pauses mid-sentence run a few seconds.
 */
const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
/** The running voiceprint averages at most this many phrases, so it keeps adapting. */
const MAX_WEIGHT = 20
const MAX_MATCHES = 5
const MAX_RECENT_WORDS = 400
/** How long a phrase waits for its audio to arrive before it is voiceprinted anyway. */
const AUDIO_WAIT_MS = 1500

type Cluster = {
  id: string
  centroid: number[]
  weight: number
  /** Speech this take, in seconds. */
  seconds: number
  mic: number
  system: number
  /** Heard in an earlier take of this session. */
  seeded: boolean
}

type SpeakerFields = {
  name: string
  personId: string | null
  confirmed: boolean
  confidence: number | null
  matches: SpeakerMatch[]
}

export type LiveSpan = { start: number; end: number; cluster: string | null; confidence: number | null }

export type LiveResult = {
  /** True when two or more people spoke in this take (meeting notes are worth writing). */
  conversation: boolean
  spans: LiveSpan[]
  clusters: { id: string; embedding: number[]; matches: SpeakerMatch[] }[]
  trace: LiveTraceEvent[]
}

const round = (value: number): number => +value.toFixed(4)

function broadcast(status: MeetingStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meeting:status', status)
}

/** The last stretch of one track's audio, addressed by session-timeline sample. */
class TrackBuffer {
  private chunks: { at: number; data: Int16Array }[] = []

  push(at: number, data: Int16Array): void {
    this.chunks.push({ at, data })
    const keepFrom = at + data.length - KEEP_SECONDS * SAMPLE_RATE
    while (this.chunks.length > 1) {
      const first = this.chunks[0]
      if (!first || first.at + first.data.length > keepFrom) break
      this.chunks.shift()
    }
  }

  /** Samples [from, to) as floats; silence where nothing was captured. */
  read(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from))
    for (const { at, data } of this.chunks) {
      const start = Math.max(from, at)
      const end = Math.min(to, at + data.length)
      for (let i = start; i < end; i++) out[i - from] = (data[i - at] ?? 0) / 32768
    }
    return out
  }

  get end(): number {
    const last = this.chunks.at(-1)
    return last ? last.at + last.data.length : 0
  }
}

type Piece = { text: string; start: number; end: number }

/**
 * Splits a committed phrase at its sentence ends, each with its own time span. The live
 * transcriber commits whatever it is sure of, which can run across a change of speaker
 * ("…ready for review. Great. Are there…"); a turn almost always changes at a sentence end, so
 * each sentence is identified on its own. The phrase is kept whole when its words can't be
 * lined up with its text (a voice command rewrote it, say).
 */
export function splitSentences(
  text: string,
  start: number,
  end: number,
  recent: readonly TranscriptWord[]
): Piece[] {
  const whole = [{ text, start, end }]
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const words = recent.filter((word) => word.start >= start - 0.01 && word.end <= end + 0.01)
  const spoken = words.flatMap((word) => word.text.trim().split(/\s+/).filter(Boolean))
  if (tokens.length < 2 || spoken.join(' ') !== tokens.join(' ')) return whole

  const pieces: Piece[] = []
  let current: TranscriptWord[] = []
  for (const word of words) {
    current.push(word)
    if (/[.!?]["')\]]?$/.test(word.text.trim())) {
      pieces.push(pieceOf(current))
      current = []
    }
  }
  if (current.length) pieces.push(pieceOf(current))
  return pieces.length > 1 ? pieces : whole
}

function pieceOf(words: TranscriptWord[]): Piece {
  return {
    text: words.map((word) => word.text.trim()).join(' '),
    start: words[0]?.start ?? 0,
    end: words.at(-1)?.end ?? 0
  }
}

function readClusters(parsed: unknown): { id: string; embedding: number[] }[] {
  const clusters = (parsed as { clusters?: unknown } | null)?.clusters
  if (!Array.isArray(clusters)) return []
  return (clusters as unknown[]).flatMap((cluster) => {
    if (!cluster || typeof cluster !== 'object') return []
    const entry = cluster as Record<string, unknown>
    if (typeof entry.id !== 'string' || !Array.isArray(entry.embedding)) return []
    return [{ id: entry.id, embedding: entry.embedding.filter((n): n is number => typeof n === 'number') }]
  })
}

/** Every speaker voiceprint a session has, from its newest pass back (live or labeled). */
export async function sessionVoiceprints(pageId: string): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>()
  const manifest = await readManifestOf(pageId)
  for (const pass of [...manifest.passes].reverse()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sessionRawDir(pageId), `${pass.id}.json`), 'utf8'))
      for (const cluster of readClusters(parsed)) {
        if (!found.has(cluster.id) && cluster.embedding.length) found.set(cluster.id, cluster.embedding)
      }
    } catch {
      // A missing or unreadable pass: try the one before.
    }
  }
  return found
}

export class LiveSession {
  private readonly buffers = new Map<AudioTrack, TrackBuffer>()
  private readonly clusters: Cluster[] = []
  private readonly spans: LiveSpan[] = []
  private models: SpeakerModels | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly matches = new Map<string, SpeakerMatch[]>()
  /** A short phrase waiting to learn its speaker from the phrase after it. */
  private held: { pieces: { text: string; last: boolean }[]; start: number; end: number } | null = null
  private readonly recentWords: TranscriptWord[] = []
  /** The text of the phrase before, to tell whether the next one opens a sentence. */
  private lastText = ''
  private readonly trace: LiveTraceEvent[] = []
  private modelsReady: Promise<void> = Promise.resolve()

  constructor(
    readonly pageId: string,
    private readonly hasSystem: boolean,
    private readonly identify: boolean
  ) {
    this.buffers.set('mic', new TrackBuffer())
    if (hasSystem) this.buffers.set('system', new TrackBuffer())
  }

  /** Opens the take: the transcriber's cursor, and the voices this session already has. */
  async begin(): Promise<void> {
    const voices = this.identify ? await sessionVoiceprints(this.pageId) : new Map<string, number[]>()
    await changeSession(this.pageId, (doc) => {
      for (const speaker of snapshotOf(doc).speakers) {
        const centroid = voices.get(speaker.id)
        if (!centroid) continue
        this.clusters.push({ id: speaker.id, centroid, weight: 5, seconds: 0, mic: 0, system: 0, seeded: true })
      }
      startTranscriber(doc, ORIGIN_TRANSCRIBER, 'transcript')
    })
    if (!this.identify) return
    // First use downloads the speaker models; until they're ready, lines have no speaker.
    let downloading = false
    this.modelsReady = ensureSpeakerModels((received, total) => {
      downloading = true
      broadcast({ pageId: this.pageId, state: 'downloading', progress: total ? received / total : 0 })
    })
      .then((models) => {
        this.models = models
        if (downloading) broadcast({ pageId: this.pageId, state: 'done', progress: 1 })
      })
      .catch((error: unknown) => {
        log('live', 'speaker models unavailable', String(error))
      })
  }

  /** Resolves once the speaker models are loaded (or failed to), for fixtures that replay audio. */
  whenReady(): Promise<void> {
    return this.modelsReady
  }

  /** Captured audio, at `at` seconds on the session timeline. */
  audio(track: AudioTrack, at: number, data: Int16Array): void {
    this.buffers.get(track)?.push(Math.round(at * SAMPLE_RATE), data)
  }

  /** A committed phrase and the stretch of the timeline it was heard in. */
  text(text: string, start: number, end: number): void {
    const pieces = splitSentences(text, start, end, this.recentWords)
    pieces.forEach((piece, index) => {
      const last = index === pieces.length - 1
      this.queue = this.queue
        .then(() => this.place(piece.text, piece.start, piece.end, last))
        .catch((error: unknown) => {
          log('live', 'could not place text', String(error))
        })
    })
  }

  /** Committed words with their times, so a phrase can be split where its sentences end. */
  words(words: readonly TranscriptWord[]): void {
    this.recentWords.push(...words)
    if (this.recentWords.length > MAX_RECENT_WORDS) {
      this.recentWords.splice(0, this.recentWords.length - MAX_RECENT_WORDS)
    }
  }

  /** Seconds of mic audio that have reached main (the renderer sends it in batches). */
  private heard(): number {
    return (this.buffers.get('mic')?.end ?? 0) / SAMPLE_RATE
  }

  /** `last`: the final piece of a phrase the window sent, which it counts as placed. */
  private async place(text: string, start: number, rawEnd: number, last: boolean): Promise<void> {
    // The transcriber can be ahead of the audio batches; give the phrase's audio time to land.
    for (let waited = 0; this.heard() < rawEnd && waited < AUDIO_WAIT_MS; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Whisper can stretch a phrase's last word past the audio; nothing was heard after `end`.
    const end = Math.max(start, Math.min(rawEnd, this.heard()))
    // Only a phrase that opens a sentence can be a new turn; "review." ends the speaker's own.
    const opensSentence = !this.lastText || /[.!?]["')\]]?$/.test(this.lastText.trim())
    this.lastText = text

    // Short phrases next to each other are voiceprinted together, once there's enough audio.
    if (this.held && start - this.held.end > SAME_TURN_GAP) await this.identifyHeld()
    const short = end - start < SHORT_PHRASE_SECONDS
    if (this.models && short && (this.held || opensSentence)) {
      if (this.held) {
        this.held.pieces.push({ text, last })
        this.held.end = end
      } else {
        this.held = { pieces: [{ text, last }], start, end }
      }
      if (this.held.end - this.held.start >= SHORT_PHRASE_SECONDS) await this.identifyHeld()
      return
    }
    const span = await this.voiceOf(start, end)
    // Short phrases just before a longer one are its speaker's (the opening of their turn).
    await this.writeHeld(span.cluster)
    this.spans.push(span)
    await this.writeLines([{ span, text, last }])
    await this.mergeAlike()
  }

  /** Folds a voice into another it has turned out to be (its lines are relabeled, not moved). */
  private async mergeAlike(): Promise<void> {
    for (const a of this.clusters) {
      for (const b of this.clusters) {
        if (a === b || (a.seeded && b.seeded) || b.seconds > a.seconds) continue
        const score = cosine(a.centroid, b.centroid)
        if (score < SAME_VOICE_THRESHOLD) continue
        this.trace.push({ kind: 'merge', at: round(this.heard()), from: b.id, into: a.id, score: round(score) })
        // `b` (the lesser voice) joins `a`.
        const total = a.weight + b.weight
        a.centroid = a.centroid.map((value, i) => (value * a.weight + (b.centroid[i] ?? 0) * b.weight) / total)
        a.weight = Math.min(total, MAX_WEIGHT)
        a.seconds += b.seconds
        a.mic += b.mic
        a.system += b.system
        for (const span of this.spans) if (span.cluster === b.id) span.cluster = a.id
        this.clusters.splice(this.clusters.indexOf(b), 1)
        await changeSession(this.pageId, (doc) => {
          doc.transact(() => {
            mergeSpeakers(doc, b.id, a.id, ORIGIN_TRANSCRIBER)
            joinSplitLines(doc, MAX_LINE_SECONDS, ORIGIN_TRANSCRIBER)
            renumberSpeakers(doc, ORIGIN_TRANSCRIBER)
          }, ORIGIN_TRANSCRIBER)
        })
        log('live', 'merged alike voices', { pageId: this.pageId, from: b.id, into: a.id })
        return this.mergeAlike()
      }
    }
  }

  /** Voiceprints the held phrases as one stretch and writes them. */
  private async identifyHeld(): Promise<void> {
    const held = this.held
    if (!held) return
    this.held = null
    const span = await this.voiceOf(held.start, held.end)
    this.spans.push(span)
    await this.writeLines(held.pieces.map((piece) => ({ span, text: piece.text, last: piece.last })))
    await this.mergeAlike()
  }

  /** Writes the held phrases as `cluster`'s (null: the speaker before them). */
  private async writeHeld(cluster: string | null): Promise<void> {
    const held = this.held
    if (!held) return
    this.held = null
    const id = cluster ?? this.spans.at(-1)?.cluster ?? null
    const owner = this.clusters.find((entry) => entry.id === id)
    if (owner) owner.seconds += held.end - held.start
    const span: LiveSpan = { start: held.start, end: held.end, cluster: owner?.id ?? null, confidence: null }
    this.trace.push({ kind: 'voice', start: held.start, end: held.end, cluster: span.cluster, decision: 'held', scores: {}, embedding: [] })
    this.spans.push(span)
    await this.writeLines(held.pieces.map((piece) => ({ span, text: piece.text, last: piece.last })))
  }

  private async writeLines(lines: { span: LiveSpan; text: string; last: boolean }[]): Promise<void> {
    const named = new Map<string, SpeakerFields>()
    const existing = new Set((await changeSession(this.pageId, snapshotOf)).speakers.map((s) => s.id))
    for (const { span } of lines) {
      const cluster = this.clusters.find((entry) => entry.id === span.cluster)
      if (cluster && !existing.has(cluster.id) && !named.has(cluster.id)) {
        named.set(cluster.id, await this.nameFor(cluster, [...named.values()]))
      }
    }
    await changeSession(this.pageId, (doc) => {
      doc.transact(() => {
        for (const [id, speaker] of named) upsertSpeaker(doc, id, speaker, ORIGIN_TRANSCRIBER)
        for (const { span, text, last } of lines) {
          appendLiveSegment(
            doc,
            {
              id: `live-${String(Math.round(span.start * 1000))}`,
              rawId: null,
              start: span.start,
              end: span.end,
              cluster: span.cluster,
              confidence: span.confidence,
              text
            },
            { joinGap: LINE_JOIN_GAP, maxLine: MAX_LINE_SECONDS },
            ORIGIN_TRANSCRIBER
          )
          if (last) markPlaced(doc, ORIGIN_TRANSCRIBER)
        }
      }, ORIGIN_TRANSCRIBER)
    })
  }

  /** Who a voice is: a saved voice, else "you" when it's mostly the mic, else Speaker N. */
  private async nameFor(cluster: Cluster, claimed: SpeakerFields[]): Promise<SpeakerFields> {
    const scores = await scoreVoices(cluster.centroid)
    const matches = scores.slice(0, MAX_MATCHES).map((entry) => ({ personId: entry.person.id, score: +entry.score.toFixed(3) }))
    this.matches.set(cluster.id, matches)
    const { speakers } = await changeSession(this.pageId, snapshotOf)
    const others: { name: string; personId: string | null }[] = [
      ...speakers.filter((s) => s.id !== cluster.id),
      ...claimed
    ]
    const taken = new Set(others.flatMap((s) => (s.personId ? [s.personId] : [])))
    const match = scores.find((entry) => entry.score >= MATCH_THRESHOLD && !taken.has(entry.person.id))
    if (match) {
      const confidence = +match.score.toFixed(3)
      return { name: match.person.name, personId: match.person.id, confirmed: confidence >= SURE_MATCH, confidence, matches }
    }
    const me = await selfPerson()
    const micShare = cluster.mic + cluster.system > 0 ? cluster.mic / (cluster.mic + cluster.system) : 0
    if (this.hasSystem && micShare >= SELF_MIC_SHARE && !(me && taken.has(me.id))) {
      return { name: me?.name ?? 'Me', personId: me?.id ?? null, confirmed: false, confidence: null, matches }
    }
    const used = new Set(others.map((s) => s.name))
    let n = 1
    while (used.has(`Speaker ${String(n)}`)) n++
    return { name: `Speaker ${String(n)}`, personId: null, confirmed: false, confidence: null, matches }
  }

  /** Voiceprints a phrase and finds (or starts) its speaker. */
  private async voiceOf(start: number, end: number): Promise<LiveSpan> {
    const previous = this.spans.at(-1)
    const reuse = (): LiveSpan => {
      const same = this.clusters.find((cluster) => cluster.id === previous?.cluster)
      if (same) same.seconds += end - start
      this.trace.push({ kind: 'voice', start, end, cluster: same?.id ?? null, decision: 'reuse', scores: {}, embedding: [] })
      return { start, end, cluster: same?.id ?? null, confidence: null }
    }
    const models = this.models
    if (!models) return reuse()

    const to = Math.round(end * SAMPLE_RATE)
    // Only the phrase's own audio: reaching back past its start would hear the previous speaker,
    // and the first phrase of every turn would go to them.
    const from = Math.max(0, Math.round(start * SAMPLE_RATE))
    const mic = this.buffers.get('mic')?.read(from, to) ?? new Float32Array(0)
    const system = this.buffers.get('system')?.read(from, to) ?? null
    if (mic.length < SHORT_PHRASE_SECONDS * SAMPLE_RATE) return reuse()
    let embedding: number[]
    try {
      embedding = await embedVoice(mixTracks(mic, system), models)
    } catch (error) {
      log('live', 'voiceprint failed', String(error))
      return reuse()
    }

    let best: Cluster | undefined
    let bestScore = -Infinity
    const scores: Record<string, number> = {}
    for (const cluster of this.clusters) {
      const score = cosine(embedding, cluster.centroid)
      scores[cluster.id] = round(score)
      if (score > bestScore) {
        best = cluster
        bestScore = score
      }
    }
    let cluster = best
    const fresh = !cluster || bestScore < JOIN_THRESHOLD
    if (!cluster || fresh) {
      cluster = { id: this.newId(), centroid: embedding, weight: 0, seconds: 0, mic: 0, system: 0, seeded: false }
      this.clusters.push(cluster)
      log('live', 'new voice', { pageId: this.pageId, id: cluster.id, closest: +bestScore.toFixed(3) })
    }
    this.trace.push({
      kind: 'voice',
      start,
      end,
      cluster: cluster.id,
      decision: fresh ? 'new' : 'join',
      scores,
      embedding: embedding.map(round)
    })
    const weight = Math.min(cluster.weight, MAX_WEIGHT)
    cluster.centroid = cluster.centroid.map((value, i) => (value * weight + (embedding[i] ?? 0)) / (weight + 1))
    cluster.weight = weight + 1
    cluster.seconds += end - start
    cluster.mic += energy(mic, 0, mic.length)
    if (system) cluster.system += energy(system, 0, system.length)
    const confidence =
      end - start >= MIN_LINE_SECONDS ? +Math.max(0, Math.min(1, cosine(embedding, cluster.centroid))).toFixed(3) : null
    return { start, end, cluster: cluster.id, confidence }
  }

  private newId(): string {
    const taken = new Set(this.clusters.map((cluster) => cluster.id))
    let n = this.clusters.length
    while (taken.has(`c${String(n)}`)) n++
    return `c${String(n)}`
  }

  /**
   * Closes the take once every phrase is placed: folds voices that barely spoke into the closest
   * real one, settles names with the final voiceprints, and returns what to keep in `raw/`.
   */
  async end(): Promise<LiveResult> {
    await this.queue
    await this.writeHeld(null)
    if (this.spans.length) await this.settle()
    const voices = new Set(this.spans.flatMap((span) => (span.cluster ? [span.cluster] : [])))
    return {
      conversation: voices.size >= 2,
      spans: this.spans,
      clusters: this.clusters
        .filter((cluster) => cluster.seeded || cluster.weight > 0)
        .map((cluster) => ({ id: cluster.id, embedding: cluster.centroid, matches: this.matches.get(cluster.id) ?? [] })),
      trace: this.trace
    }
  }

  private async settle(): Promise<void> {
    const real = this.clusters.filter((cluster) => cluster.seeded || cluster.seconds >= MIN_SPEAKER_SECONDS)
    const tiny = this.clusters.filter((cluster) => !real.includes(cluster))
    const into = new Map<string, string>()
    for (const cluster of tiny) {
      let best: Cluster | undefined
      let bestScore = -Infinity
      for (const candidate of real) {
        const score = cosine(cluster.centroid, candidate.centroid)
        if (score > bestScore) {
          best = candidate
          bestScore = score
        }
      }
      if (best) {
        into.set(cluster.id, best.id)
        this.trace.push({ kind: 'fold', from: cluster.id, into: best.id })
      }
    }
    for (const span of this.spans) {
      if (span.cluster) span.cluster = into.get(span.cluster) ?? span.cluster
    }
    for (const id of into.keys()) {
      const index = this.clusters.findIndex((cluster) => cluster.id === id)
      if (index >= 0) this.clusters.splice(index, 1)
    }

    // Names chosen from a voice's first phrases may improve now that it has said more.
    const { speakers } = await changeSession(this.pageId, snapshotOf)
    const renames = new Map<string, SpeakerFields>()
    for (const speaker of speakers) {
      const cluster = this.clusters.find((entry) => entry.id === speaker.id)
      if (!cluster || cluster.seeded) continue
      if (speaker.confirmed) continue
      const named = await this.nameFor(cluster, [...renames.values()])
      // Only a saved voice is worth renaming for; a placeholder stays what the user has seen.
      if (named.personId && named.personId !== speaker.personId) renames.set(speaker.id, named)
    }
    await changeSession(this.pageId, (doc) => {
      doc.transact(() => {
        for (const [from, to] of into) mergeSpeakers(doc, from, to, ORIGIN_TRANSCRIBER)
        if (into.size) joinSplitLines(doc, MAX_LINE_SECONDS, ORIGIN_TRANSCRIBER)
        for (const [id, speaker] of renames) upsertSpeaker(doc, id, speaker, ORIGIN_TRANSCRIBER)
        renumberSpeakers(doc, ORIGIN_TRANSCRIBER)
      }, ORIGIN_TRANSCRIBER)
    })
    // Confident matches teach the voiceprint, so it keeps up with mics and rooms.
    for (const [id, speaker] of renames) {
      const cluster = this.clusters.find((entry) => entry.id === id)
      if (cluster && speaker.personId && (speaker.confidence ?? 0) >= REINFORCE_THRESHOLD) {
        await addSample(speaker.personId, cluster.centroid)
      }
    }
    if (into.size) log('live', 'folded brief voices', Object.fromEntries(into))
  }
}

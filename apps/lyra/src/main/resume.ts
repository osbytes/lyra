import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { appendLiveSegment } from '../shared/sessionDoc'
import type { AudioTrack } from '../shared/types'
import { end as endActivity, report as reportActivity } from './activity'
import {
  LIVE_FILE,
  liveSegmentOf,
  liveSegments,
  marksToResume,
  mergeLivePass,
  parseLiveFile,
  writeLiveFile,
  type LiveFile,
  type LiveSegment
} from './livePass'
import { log } from './log'
import type { RelabelOutcome } from './meeting/relabel'
import { readWav } from './meeting/wav'
import { notesDir } from './pages'
import { settle } from './pendingWork'
import { recordingPageId, trackPath } from './recorder'
import { newWords, resumeSpans, spanTracks, type ResumeSpan } from './resumePlan'
import { changeSession, peekManifest, sessionIds, sessionRawDir } from './sessionStore'
import { createSpeechClassifier, ensureSpeechVad } from './speechVad'
import { promptFor } from './takeWriter'
import { ChunkedTranscriber, type TranscribedChunk } from './transcriber'
import { BYTES_PER_SECOND, dataBytesOf, SAMPLE_RATE } from './wavFile'
import { MODEL_LABEL, transcribePcm } from './whisper'

/**
 * Picks up, once at startup, what a quit or crash cut short, one session at a time. Only
 * sessions whose manifest owes something are read (`Manifest.pending`):
 *
 * 1. `transcribe`: audio recorded but not transcribed (the `untranscribed` marks in
 *    `raw/live.json`: the recorder saves its words every few seconds with a mark of what comes
 *    after them, and at a quit that couldn't wait for Whisper) is transcribed from the audio.
 * 2. `speakers`: settled over the whole recording, which also rebuilds the lines from every word,
 *    the recovered ones included; that run then owes the summary and asks for it, as after any
 *    recording. Recovered words get a relabel even if the speakers had been settled already.
 * 3. `notes`: a summary still owed is written.
 *
 * Model downloads resume on their own: each of these steps fetches the model it needs, and a
 * download picks up from its `.part` file (`models.ts`). The long steps keep checkpoints of their
 * own (`checkpoints.ts`), so what they had done before is not done again.
 */

export type ResumeDeps = {
  /** Whether speakers are settled after a recording (off in test runs, without the models). */
  speakers: boolean
  relabel: (pageId: string) => Promise<RelabelOutcome>
  writeNotes: (pageId: string) => Promise<void>
}

const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
/** Audio is read and fed to the transcriber this much at a time, so a long backlog isn't all in memory. */
const READ_SECONDS = 30

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type LiveRead = { state: 'missing' } | { state: 'ok'; file: LiveFile } | { state: 'unreadable' }

/**
 * `raw/live.json` as it is. Never moved aside here, unlike when recording: a file a sync client
 * is still writing, or one from a newer Lyra, is left for later and the step stays owed.
 */
async function readLive(pageId: string): Promise<LiveRead> {
  const path = join(sessionRawDir(pageId), LIVE_FILE)
  if (!existsSync(path)) return { state: 'missing' }
  const file = parseLiveFile(await readFile(path, 'utf8'))
  return file ? { state: 'ok', file } : { state: 'unreadable' }
}

/** The file now, for a write that merges into it; refuses to write over one it can't read. */
async function liveForWrite(pageId: string): Promise<LiveFile | null> {
  const live = await readLive(pageId)
  if (live.state === 'unreadable') throw new Error('live.json became unreadable while resuming')
  return live.state === 'ok' ? live.file : null
}

async function trackSeconds(pageId: string, track: AudioTrack): Promise<number> {
  const path = trackPath(pageId, track)
  if (!existsSync(path)) return 0
  return dataBytesOf((await stat(path)).size) / BYTES_PER_SECOND
}

/**
 * Whisper's prompt for a span: the session's title and the words heard just before it, as the
 * recording would have given it, not text from after the gap.
 */
async function promptBefore(pageId: string, file: LiveFile, from: number): Promise<string> {
  const title = await changeSession(pageId, (doc) => doc.title)
  const before = liveSegments(file)
    .filter((segment) => segment.end <= from)
    .sort((a, b) => a.start - b.start)
    .map((segment) => segment.words.map((word) => word.text).join(''))
  return promptFor(title, before.join(' '))
}

/** Transcribes one take's untranscribed audio the way it would have been while recording. */
async function transcribeSpan(
  pageId: string,
  span: ResumeSpan,
  context: string,
  onSeconds: (seconds: number) => void
): Promise<TranscribedChunk[]> {
  const tracks = spanTracks(span).filter((track) => existsSync(trackPath(pageId, track)))
  const chunks: TranscribedChunk[] = []
  const transcriber = new ChunkedTranscriber(
    tracks,
    Math.round(span.from * SAMPLE_RATE),
    transcribePcm,
    (chunk) => {
      const kept = newWords(chunk, span.marks)
      if (kept) chunks.push(kept)
    },
    undefined,
    { context, classifier: createSpeechClassifier }
  )
  for (let at = span.from; at < span.to; at += READ_SECONDS) {
    const until = Math.min(span.to, at + READ_SECONDS)
    // Both tracks are cut to the same length, so they stay aligned as the transcriber pairs them.
    const length = Math.round((until - at) * SAMPLE_RATE)
    for (const track of tracks) {
      const read = await readWav(trackPath(pageId, track), at, until)
      const samples = new Float32Array(length)
      samples.set(read.subarray(0, length))
      transcriber.audio(track, samples)
    }
    await transcriber.settled()
    onSeconds(until - span.from)
  }
  await transcriber.finish()
  return chunks
}

/**
 * Lines for the recovered words, where the session doesn't already show them: only when no
 * relabel rebuilt the lines from every word. A line of the same track over the same time (as the
 * take wrote it, `live-<track>-…`, or as live labeling rewrote it, `roll-<track>-…`) already does.
 */
function appendRecovered(pageId: string, segments: readonly LiveSegment[]): Promise<void> {
  return changeSession(pageId, (doc) => {
    const shown = (segment: LiveSegment): boolean =>
      doc.transcript.some(
        (line) =>
          (line.id.startsWith(`live-${segment.track}-`) || line.id.startsWith(`roll-${segment.track}-`)) &&
          line.start < segment.end &&
          segment.start < line.end
      )
    const ordered = [...segments].sort((a, b) => a.start - b.start)
    for (const segment of ordered) {
      if (shown(segment)) continue
      const text = segment.words.map((word) => word.text).join('')
      // At the end, as a take writes; the next relabel puts every line in time order.
      appendLiveSegment(
        doc,
        {
          id: segment.id,
          rawId: null,
          start: segment.start,
          end: segment.end,
          cluster: null,
          confidence: null,
          text
        },
        { joinGap: LINE_JOIN_GAP, maxLine: MAX_LINE_SECONDS }
      )
    }
  })
}

/**
 * Drops the marks of `takes`, all transcribed now or with nothing left to transcribe (their audio
 * was deleted, or it was all heard after all). A take recorded since keeps its own.
 */
async function dropMarks(pageId: string, takes: ReadonlySet<number>): Promise<void> {
  const current = await liveForWrite(pageId)
  if (!current) return
  const marks = current.untranscribed ?? []
  const kept = marks.filter((mark) => !takes.has(mark.take))
  if (kept.length === marks.length) return
  const { untranscribed: _, ...rest } = current
  await writeLiveFile(sessionRawDir(pageId), kept.length ? { ...rest, untranscribed: kept } : rest)
}

/**
 * Transcribes the audio `file` marks as untranscribed, and saves the words with the marks gone.
 * Returns the recovered segments.
 */
async function resumeTranscription(pageId: string, file: LiveFile): Promise<LiveSegment[]> {
  const lengths = { mic: await trackSeconds(pageId, 'mic'), system: await trackSeconds(pageId, 'system') }
  const spans = resumeSpans(marksToResume(file.untranscribed ?? [], (track) => lengths[track]))
  const total = spans.reduce((sum, span) => sum + span.to - span.from, 0)
  const activity = {
    id: `transcribe:${pageId}`,
    kind: 'transcribe' as const,
    origin: 'session' as const,
    pageId
  }
  const started = Date.now()
  const takes = new Set((file.untranscribed ?? []).map((mark) => mark.take))
  let done = 0
  const recovered: LiveSegment[] = []
  try {
    if (spans.length) await ensureSpeechVad()
    for (const span of spans) {
      const context = await promptBefore(pageId, file, span.from)
      const chunks = await transcribeSpan(pageId, span, context, (seconds) => {
        reportActivity({
          ...activity,
          title: 'Transcribing an interrupted recording',
          detail: `${String(Math.round(done + seconds))} of ${String(Math.round(total))} s`,
          progress: total ? (done + seconds) / total : null
        })
      })
      done += span.to - span.from
      const segments = chunks.map(liveSegmentOf)
      recovered.push(...segments)
      const pass = mergeLivePass(await liveForWrite(pageId), {
        model: MODEL_LABEL,
        createdAt: new Date().toISOString(),
        take: span.take,
        segments,
        untranscribed: []
      })
      // Saved a take at a time, so a second interruption keeps what this one recovered.
      await writeLiveFile(sessionRawDir(pageId), pass)
    }
    await dropMarks(pageId, takes)
    log('resume', 'transcribed interrupted audio', {
      pageId,
      seconds: +total.toFixed(1),
      words: recovered.reduce((sum, segment) => sum + segment.words.length, 0),
      ms: Date.now() - started
    })
    if (spans.length) endActivity({ ...activity, title: 'Transcribed an interrupted recording' }, 'done')
    return recovered
  } catch (error) {
    endActivity(
      { ...activity, title: "Couldn't transcribe an interrupted recording", detail: errorMessage(error) },
      'failed'
    )
    throw error
  }
}

/** Transcribes what a take left untranscribed, if anything; the recovered segments. */
async function resumeOwedTranscription(pageId: string): Promise<LiveSegment[]> {
  const live = await readLive(pageId)
  if (live.state === 'unreadable') {
    log('resume', 'live.json is unreadable; transcription left owed', { pageId })
    return []
  }
  try {
    const marked = live.state === 'ok' && live.file.untranscribed?.length
    const recovered = marked ? await resumeTranscription(pageId, live.file) : []
    await settle(pageId, 'transcribe')
    return recovered
  } catch (error) {
    // Reported in Activity; owed no more, so one bad recording can't hold up its speakers and
    // summary at every start. Its marks stay in live.json for `pnpm replay:session`.
    log('resume', 'could not transcribe interrupted audio', { pageId, error: errorMessage(error) })
    await settle(pageId, 'transcribe')
    return []
  }
}

async function resumeSession(pageId: string, deps: ResumeDeps): Promise<boolean> {
  const pending = peekManifest(pageId)?.pending ?? []
  if (!pending.length) return false
  log('resume', 'resuming', { pageId, pending })
  const recovered = pending.includes('transcribe') ? await resumeOwedTranscription(pageId) : []
  const relabel = deps.speakers && (pending.includes('speakers') || recovered.length > 0)
  // A labeled run owes the summary and asks for it itself.
  const outcome: RelabelOutcome = relabel ? await deps.relabel(pageId) : 'skipped'
  if (!deps.speakers && pending.includes('speakers')) await settle(pageId, 'speakers')
  if (outcome === 'skipped' && recovered.length) await appendRecovered(pageId, recovered)
  if (outcome !== 'labeled' && pending.includes('notes')) await deps.writeNotes(pageId)
  return true
}

/** Resumes every session's unfinished work, one session at a time; see the top of this file. */
export async function resumeUnfinishedWork(deps: ResumeDeps): Promise<void> {
  let resumed = 0
  for (const pageId of await sessionIds()) {
    // A session whose note is gone has nowhere to put the work; one being recorded is the recorder's.
    if (!existsSync(join(notesDir(), pageId)) || recordingPageId() === pageId) continue
    try {
      if (await resumeSession(pageId, deps)) resumed++
    } catch (error) {
      log('resume', 'could not resume a session', { pageId, error: errorMessage(error) })
    }
  }
  if (resumed) log('resume', 'resumed unfinished work', { sessions: resumed })
}

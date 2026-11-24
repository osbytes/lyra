import type * as Y from 'yjs'
import type { AudioTrack, Person } from '../shared/types'
import {
  appendLiveSegment,
  newSpeakerId,
  ORIGIN_TRANSCRIBER,
  snapshotOf,
  startTranscriber,
  upsertSpeaker,
  type SpeakerEntry,
  type TranscriptSegment
} from '../shared/sessionDoc'
import { log } from './log'
import { changeSession } from './sessionStore'
import type { TranscribedChunk } from './transcriber'
import { selfPerson } from './voices'

/**
 * Writes a take's transcribed chunks into its session as transcript lines. On a call (a system
 * track alongside the mic) each line is labeled by the track it was heard on: the mic is the
 * person at this computer, the system track is "Remote". Those labels hold until the recording
 * stops and the speakers are settled from the whole recording (`meeting/relabel.ts`), which also
 * tells apart several people on either side. Without a system track lines have no speaker until
 * then, and one voice reads as plain paragraphs.
 */

/** One line per turn: the same speaker continuing within this gap, up to MAX_LINE_SECONDS. */
const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
const REMOTE = 'Remote'
/** The person at this computer before they've saved their voice (as `meeting/pipeline.ts` names them). */
const SELF = 'Me'
/** Text before the recording that Whisper is given as context. */
const CONTEXT_CHARS = 300
/**
 * Whisper copies the style of its prompt. With nothing before the recording there's nothing to
 * copy, so give it a punctuated sentence to nudge it toward full punctuation.
 */
const STYLE_SEED = 'Okay, so here are my thoughts, written out in full sentences.'

/** The session's title and the end of its transcript, as Whisper's first prompt. */
function promptFor(title: string, transcript: string): string {
  const tail = transcript.replace(/\s+/g, ' ').trim().slice(-CONTEXT_CHARS)
  const start = tail.length === CONTEXT_CHARS ? tail.indexOf(' ') + 1 : 0
  const heading = title && title !== 'Untitled' ? `${title}. ` : ''
  return `${heading}${tail.slice(start)}`.trim() || STYLE_SEED
}

export class TakeWriter {
  private readonly speakerOf = new Map<AudioTrack, string>()
  private readonly heard = new Set<AudioTrack>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly pageId: string,
    private readonly hasSystem: boolean,
    /** Where each track was heard in earlier takes, to find who spoke on it since relabeling. */
    private readonly earlier: readonly HeardSpan[] = []
  ) {}

  /** Opens the take in the session and returns the text before it, as Whisper's context. */
  async begin(): Promise<string> {
    return changeSession(this.pageId, (doc) => {
      startTranscriber(doc, ORIGIN_TRANSCRIBER, 'transcript')
      const { title, transcript } = snapshotOf(doc)
      return promptFor(title, transcript.map((line) => line.text).join(' '))
    })
  }

  write(chunk: TranscribedChunk): void {
    this.heard.add(chunk.track)
    this.writes = this.writes
      .then(() => this.append(chunk))
      .catch((error: unknown) => {
        log('transcriber', 'could not write a chunk', { pageId: this.pageId, error: String(error) })
      })
  }

  /** Waits for every line to be written; true when both sides of a call spoke. */
  async end(): Promise<boolean> {
    await this.writes
    return this.heard.size >= 2
  }

  private async append(chunk: TranscribedChunk): Promise<void> {
    const text = chunk.words.map((word) => word.text).join('')
    const first = chunk.words[0]
    const last = chunk.words.at(-1)
    if (!text.trim() || !first || !last) return
    const me = this.hasSystem && chunk.track === 'mic' ? await selfPerson() : null
    await changeSession(this.pageId, (doc) => {
      // Resolved in the same edit as the line, so it can't point at a speaker removed meanwhile.
      const cluster = this.hasSystem ? this.speakerFor(doc, chunk.track, me) : null
      appendLiveSegment(
        doc,
        {
          id: `live-${chunk.track}-${String(Math.round(first.start * 1000))}`,
          rawId: null,
          start: first.start,
          end: last.end,
          cluster,
          confidence: null,
          text
        },
        { joinGap: LINE_JOIN_GAP, maxLine: MAX_LINE_SECONDS },
        ORIGIN_TRANSCRIBER
      )
    })
  }

  /**
   * The speaker a track's lines go to: you on the mic, "Remote" on the system track. After an
   * earlier take was relabeled those names may be gone, so the speaker who did most of the talking
   * on this track before carries on instead of a duplicate appearing.
   */
  private speakerFor(doc: Y.Doc, track: AudioTrack, me: Person | null): string {
    const { speakers, transcript } = snapshotOf(doc)
    const known = this.speakerOf.get(track)
    if (known && speakers.some((speaker) => speaker.id === known)) return known
    const existing =
      mostHeardOn(track, this.earlier, transcript, speakers) ??
      (track === 'mic'
        ? speakers.find((speaker) => (me ? speaker.personId === me.id : speaker.name === SELF))?.id
        : speakers.find((speaker) => speaker.name === REMOTE && speaker.personId === null)?.id)
    const id = existing ?? newSpeakerId(doc)
    if (!existing) {
      upsertSpeaker(
        doc,
        id,
        {
          name: track === 'mic' ? (me?.name ?? SELF) : REMOTE,
          personId: me?.id ?? null,
          confirmed: false,
          confidence: null,
          matches: []
        },
        ORIGIN_TRANSCRIBER
      )
    }
    this.speakerOf.set(track, id)
    return id
  }
}

/** A stretch of an earlier take heard on one track (from `raw/live.json`). */
export type HeardSpan = { track: AudioTrack; start: number; end: number }

/**
 * The speaker whose lines share the most time with what was heard on `track` in earlier takes,
 * not counting a speaker who mostly talked on the other track (on a call the far end bleeds into
 * the mic, but less than the person at it).
 */
function mostHeardOn(
  track: AudioTrack,
  earlier: readonly HeardSpan[],
  lines: readonly TranscriptSegment[],
  speakers: readonly SpeakerEntry[]
): string | undefined {
  const talk = new Map<string, Record<AudioTrack, number>>()
  for (const line of lines) {
    if (!line.cluster || !speakers.some((speaker) => speaker.id === line.cluster)) continue
    const entry = talk.get(line.cluster) ?? { mic: 0, system: 0 }
    for (const span of earlier) {
      entry[span.track] += Math.max(0, Math.min(line.end, span.end) - Math.max(line.start, span.start))
    }
    talk.set(line.cluster, entry)
  }
  const other: AudioTrack = track === 'mic' ? 'system' : 'mic'
  let best: string | undefined
  let most = 0
  for (const [id, entry] of talk) {
    if (entry[track] > most && entry[track] >= entry[other]) {
      most = entry[track]
      best = id
    }
  }
  return best
}

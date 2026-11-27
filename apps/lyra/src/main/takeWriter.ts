import type { AudioTrack, TranscriptWord } from '../shared/types'
import { appendLiveSegment, type SessionDoc } from '../shared/sessionDoc'
import { log } from './log'
import { changeSession } from './sessionStore'
import type { TranscribedChunk } from './transcriber'

/**
 * Writes a take's transcribed chunks into its session as transcript lines, with no speaker: the
 * track a line was heard on says where the sound came from, not who made it (two people share a
 * desk mic, several are on one call), and a name shown on a guess reads as a fact. Speakers are
 * settled from the voices: every half minute while recording (`meeting/liveLabels.ts`, which
 * rewrites these lines through `rewrite`) and for good once it stops (`meeting/relabel.ts`).
 * The two tracks stay on separate lines.
 */

/** One line per turn: the same track continuing within this gap, up to MAX_LINE_SECONDS. */
const LINE_JOIN_GAP = 8
const MAX_LINE_SECONDS = 30
/** Text before the recording that Whisper is given as context. */
const CONTEXT_CHARS = 300
/**
 * Whisper copies the style of its prompt. With nothing before the recording there's nothing to
 * copy, so give it a punctuated sentence to nudge it toward full punctuation.
 */
const STYLE_SEED = 'Okay, so here are my thoughts, written out in full sentences.'

/** The session's title and the end of its transcript, as Whisper's first prompt. */
export function promptFor(title: string, transcript: string): string {
  const tail = transcript.replace(/\s+/g, ' ').trim().slice(-CONTEXT_CHARS)
  const start = tail.length === CONTEXT_CHARS ? tail.indexOf(' ') + 1 : 0
  const heading = title && title !== 'Untitled' ? `${title}. ` : ''
  return `${heading}${tail.slice(start)}`.trim() || STYLE_SEED
}

/** A word of this take and the track it was heard on. */
export type TakeWord = TranscriptWord & { track: AudioTrack }

export class TakeWriter {
  private readonly heard = new Set<AudioTrack>()
  /** Every word written so far, in the order it was written: what the session's lines hold. */
  private readonly words: TakeWord[] = []
  /** Words of chunks handed over but not written yet. */
  private queued: TakeWord[] = []
  private lastTrack: AudioTrack | null = null
  private open = true
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly pageId: string) {}

  /** Opens the take in the session and returns the text before it, as Whisper's context. */
  async begin(): Promise<string> {
    return changeSession(this.pageId, ({ title, transcript }) =>
      promptFor(title, transcript.map((line) => line.text).join(' '))
    )
  }

  write(chunk: TranscribedChunk): void {
    this.heard.add(chunk.track)
    const words = chunk.words.map((word) => ({ ...word, track: chunk.track }))
    this.queued.push(...words)
    this.writes = this.writes
      .then(() => this.append(chunk))
      .catch((error: unknown) => {
        log('transcriber', 'could not write a chunk', { pageId: this.pageId, error: String(error) })
      })
      .finally(() => {
        this.queued = this.queued.filter((word) => !words.includes(word))
      })
  }

  /**
   * Runs `change` on the session between two chunks, with the take's words as the session holds
   * them at that moment: a rewrite of its lines can't lose a chunk written just before it or
   * double one written just after. Null once the take has ended, when nothing was changed.
   */
  rewrite<T>(change: (doc: SessionDoc, words: readonly TakeWord[]) => T): Promise<T | null> {
    const result = this.writes.then(() =>
      this.open ? changeSession(this.pageId, (doc) => change(doc, this.words)) : null
    )
    this.writes = result.then(
      () => undefined,
      (error: unknown) => {
        log('transcriber', 'could not rewrite the lines', { pageId: this.pageId, error: String(error) })
      }
    )
    return result
  }

  /** The words transcribed so far, written into the session or about to be. */
  heardSoFar(): readonly TakeWord[] {
    return [...this.words, ...this.queued]
  }

  /** Waits for every line to be written; true when both sides of a call spoke. */
  async end(): Promise<boolean> {
    await this.writes
    this.open = false
    return this.heard.size >= 2
  }

  private async append(chunk: TranscribedChunk): Promise<void> {
    const text = chunk.words.map((word) => word.text).join('')
    const first = chunk.words[0]
    const last = chunk.words.at(-1)
    if (!text.trim() || !first || !last) return
    // A line never runs across tracks: no gap is short enough to join the other one's.
    const joinGap = chunk.track === this.lastTrack ? LINE_JOIN_GAP : Number.NEGATIVE_INFINITY
    await changeSession(this.pageId, (doc) => {
      appendLiveSegment(
        doc,
        {
          id: `live-${chunk.track}-${String(Math.round(first.start * 1000))}`,
          rawId: null,
          start: first.start,
          end: last.end,
          cluster: null,
          confidence: null,
          text
        },
        { joinGap, maxLine: MAX_LINE_SECONDS }
      )
    })
    this.lastTrack = chunk.track
    for (const word of chunk.words) this.words.push({ ...word, track: chunk.track })
  }
}

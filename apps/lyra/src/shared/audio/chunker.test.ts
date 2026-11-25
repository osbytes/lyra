import { describe, expect, it } from 'vitest'
import { PauseChunker, type CutChunk } from './chunker'
import { rms, SAMPLE_RATE, type SpeechClassifier } from './vad'

/** The capture worklet's frame: 32 ms. */
const FRAME = 512
const MS = SAMPLE_RATE / 1000
const TAIL = 300 * MS
/** How far before the first voiced frame a chunk starts: the detector's pre-roll less its onset. */
const LEAD = 10 * FRAME - 3 * FRAME

type Kind = 'speech' | 'quiet' | 'silence'
type Segment = [Kind, number]
/** A span of voiced audio on the timeline, in samples. */
type Span = { start: number; end: number }

const LOUD = 0.1
const SOFT = 0.02

function frameOf(kind: Kind, offset: number): Float32Array {
  const frame = new Float32Array(FRAME)
  if (kind === 'silence') return frame
  const amplitude = kind === 'speech' ? LOUD : SOFT
  for (let i = 0; i < FRAME; i++) frame[i] = amplitude * Math.sin((2 * Math.PI * 220 * (offset + i)) / SAMPLE_RATE)
  return frame
}

/** Hears a voice above a fixed level: deterministic, frame by frame, like Silero on clean audio. */
const fakeSilero = (): SpeechClassifier => ({ isSpeech: (frame) => rms(frame) > 0.01 })

function frames(ms: number): number {
  return Math.round(ms / 32)
}

type Run = {
  chunks: CutChunk[]
  spans: Span[]
  end: number
  /** Times `pendingFrom()` went back, or a chunk started before a point already reported done. */
  backwards: number
}

/**
 * Feeds the segments (kind, length in ms) through a chunker frame by frame, counting each time the
 * chunker hands out audio from before a point it already said was done: the transcriber releases
 * the other track's lines up to that point, so going back would put lines out of order.
 */
function run(segments: readonly Segment[], classifier: SpeechClassifier | null, flush = true): Run {
  const chunks: CutChunk[] = []
  let floor = 0
  let backwards = 0
  const chunker = new PauseChunker((chunk) => {
    if (chunk.start < floor) backwards++
    chunks.push(chunk)
  }, classifier)
  const spans: Span[] = []
  let at = 0
  for (const [kind, ms] of segments) {
    const start = at
    for (let i = 0; i < frames(ms); i++) {
      chunker.push(frameOf(kind, at), at)
      at += FRAME
      const pending = chunker.pendingFrom()
      if (pending < floor) backwards++
      floor = Math.max(floor, pending)
    }
    if (kind !== 'silence') spans.push({ start, end: at })
  }
  if (flush) chunker.flush()
  return { chunks, spans, end: at, backwards }
}

const chunkEnd = (chunk: CutChunk): number => chunk.start + chunk.pcm.length

function covers(chunk: CutChunk, span: Span): boolean {
  return chunk.start <= span.start && chunkEnd(chunk) >= span.end
}

function contiguous(chunks: readonly CutChunk[]): void {
  for (let i = 1; i < chunks.length; i++) {
    const before = chunks[i - 1]
    const after = chunks[i]
    if (before && after) expect(after.start).toBeGreaterThanOrEqual(chunkEnd(before))
  }
}

describe.each([
  ['Silero', fakeSilero],
  ['energy fallback', () => null]
])('PauseChunker (%s)', (_name, classifier) => {
  it('drops a cough-length blip with nothing after it', () => {
    const { chunks } = run(
      [
        ['silence', 1000],
        ['speech', 150],
        ['silence', 6000]
      ],
      classifier()
    )
    expect(chunks).toEqual([])
  })

  it('keeps a lone short reply, trimmed, once nothing follows it', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 300],
        ['silence', 6000]
      ],
      classifier(),
      false
    )
    const [yes] = spans
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    if (!chunk || !yes) throw new Error('missing chunk')
    expect(chunk.start).toBe(yes.start - LEAD)
    expect(chunkEnd(chunk)).toBe(yes.end + TAIL)
  })

  it('keeps a short fragment and a quick continuation in one chunk', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 500],
        ['silence', 600],
        ['speech', 2000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    if (!chunk) throw new Error('missing chunk')
    for (const span of spans) expect(covers(chunk, span)).toBe(true)
  })

  it('holds a short fragment past the end pause for speech that follows within the wait', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 500],
        ['silence', 2000],
        ['speech', 2000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    const last = spans.at(-1)
    if (!chunk || !last) throw new Error('missing chunk')
    for (const span of spans) expect(covers(chunk, span)).toBe(true)
    expect(chunkEnd(chunk)).toBe(last.end + TAIL)
  })

  it('sends a short fragment alone when the next speech comes after the wait', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 500],
        ['silence', 4000],
        ['speech', 2000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(2)
    contiguous(chunks)
    const [first, second] = chunks
    const [fragment, rest] = spans
    if (!first || !second || !fragment || !rest) throw new Error('missing chunk')
    expect(covers(first, fragment)).toBe(true)
    expect(chunkEnd(first)).toBe(fragment.end + TAIL)
    expect(covers(second, rest)).toBe(true)
  })

  it('trims a long utterance to its last speech plus the tail', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 5000],
        ['silence', 5000]
      ],
      classifier(),
      false
    )
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    const [span] = spans
    if (!chunk || !span) throw new Error('missing chunk')
    expect(chunk.start).toBe(span.start - LEAD)
    expect(chunkEnd(chunk)).toBe(span.end + TAIL)
  })

  it("starts the next chunk on its own pre-roll, after the last one's tail", () => {
    const { chunks, spans, backwards } = run(
      [
        ['silence', 1000],
        ['speech', 3000],
        ['silence', 1500],
        ['speech', 3000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(2)
    contiguous(chunks)
    const [first, second] = chunks
    const [one, two] = spans
    if (!first || !second || !one || !two) throw new Error('missing chunk')
    expect(chunkEnd(first)).toBe(one.end + TAIL)
    expect(second.start).toBe(two.start - LEAD)
    expect(backwards).toBe(0)
  })

  it('cuts a long stretch at its quietest point and carries on from there', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 20_000],
        ['quiet', 320],
        ['speech', 15_000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(2)
    const [first, second] = chunks
    const [, dip, rest] = spans
    if (!first || !second || !dip || !rest) throw new Error('missing chunk')
    // Cut inside the quiet stretch, with nothing between the halves.
    expect(chunkEnd(first)).toBeGreaterThan(dip.start)
    expect(chunkEnd(first)).toBeLessThanOrEqual(dip.end)
    expect(second.start).toBe(chunkEnd(first))
    expect(chunkEnd(second)).toBe(rest.end + TAIL)
  })

  it('does not send the silence left over when a cut lands in the end pause', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 27_000],
        ['silence', 6000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    const [span] = spans
    if (!chunk || !span) throw new Error('missing chunk')
    expect(covers(chunk, span)).toBe(true)
  })

  it('carries on from a cut in a pause when the speaker resumes', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 27_000],
        ['silence', 900],
        ['speech', 2000],
        ['silence', 4000]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(2)
    const [first, second] = chunks
    const [one, two] = spans
    if (!first || !second || !one || !two) throw new Error('missing chunk')
    expect(covers(first, one)).toBe(true)
    expect(second.start).toBe(chunkEnd(first))
    expect(covers(second, two)).toBe(true)
    expect(chunkEnd(second)).toBe(two.end + TAIL)
  })

  it('hands out a trailing short reply when recording stops', () => {
    const { chunks, spans } = run(
      [
        ['silence', 1000],
        ['speech', 300],
        ['silence', 200]
      ],
      classifier()
    )
    expect(chunks).toHaveLength(1)
    const [chunk] = chunks
    const [okay] = spans
    if (!chunk || !okay) throw new Error('missing chunk')
    expect(covers(chunk, okay)).toBe(true)
  })

  it('trims the trailing silence at stop, but not speech cut off by it', () => {
    const paused = run(
      [
        ['silence', 1000],
        ['speech', 3000],
        ['silence', 800]
      ],
      classifier()
    )
    const [pausedSpan] = paused.spans
    expect(paused.chunks.map(chunkEnd)).toEqual([(pausedSpan?.end ?? 0) + TAIL])

    const talking = run(
      [
        ['silence', 1000],
        ['speech', 3000]
      ],
      classifier()
    )
    expect(talking.chunks.map(chunkEnd)).toEqual([talking.end])
  })

  it('drops a blip at stop', () => {
    const { chunks } = run(
      [
        ['silence', 1000],
        ['speech', 150],
        ['silence', 100]
      ],
      classifier()
    )
    expect(chunks).toEqual([])
  })
})

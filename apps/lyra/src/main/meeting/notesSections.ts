/**
 * Cuts a long meeting into sections on one topic each, so every section's notes come from one
 * model call that sees the whole discussion of that topic.
 *
 * The transcript is grouped into blocks of about a minute. Each gap between blocks is scored by
 * how alike the words before and after it are (TextTiling: Hearst, 1997), and a dip deeper than
 * its neighbors marks a likely change of topic. A dynamic program then picks the cuts that land
 * on the deepest dips while keeping sections near a target length and always within the token
 * room one call has (the globally best cut, as in Zoom's meeting segmenter, rather than greedy
 * thresholds). Words are found with `Intl.Segmenter`, so it works for languages written without
 * spaces too. Pure: no model, so it runs in the notes worker and in unit tests.
 */
import { lineText, splitLong, type TokenCounter } from './notesChunks'
import type { NotesLine } from './notesFormat'

/** A block closes after this much talk: short enough to place a cut within a minute. */
const BLOCK_SECONDS = 60
/** A block's size when lines have no times (typed or imported text): about a minute of talk. */
const BLOCK_TOKENS = 200
/** How speech converts to tokens when there are no times: ~150 words a minute, ~1.3 tokens each. */
const TOKENS_PER_SECOND = 3.3
/** Blocks compared on each side of a gap: three minutes is enough to tell a topic apart. */
const WINDOW_BLOCKS = 3
/** What a section aims for: long enough to hold a discussion, short enough to summarize well. */
export const TARGET_SECONDS = 8 * 60
/** No section runs longer than this, however much room the model has. */
const MAX_SECONDS = 20 * 60
/**
 * How much a section's distance from the target costs against a topic change (depths are
 * scaled to 0–1): half the target costs 0.25, so only a clear dip makes a section that short.
 */
const LENGTH_WEIGHT = 1

export type SectionOptions = {
  /** Tokens of transcript one section may take (`Name: text` lines, one per line). */
  room: number
  count: TokenCounter
}

type Block = { from: number; to: number; start: number; end: number; tokens: number }

/** Lines too long to share a block are split, their time shared out by length. */
function fitLines(lines: NotesLine[], maxTokens: number, count: TokenCounter): NotesLine[] {
  return lines.flatMap((line) => {
    if (count(lineText(line)) + 1 <= maxTokens) return [line]
    const room = Math.max(1, maxTokens - count(`${line.speaker}: `) - 1)
    const pieces = splitLong(line.text, room, count)
    const length = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1
    let at = line.start
    return pieces.map((piece) => {
      const start = at
      at += ((line.end - line.start) * piece.length) / length
      return { ...line, text: piece.trim(), start, end: at }
    })
  })
}

function blocksOf(lines: NotesLine[], tokens: number[], timed: boolean, maxTokens: number): Block[] {
  const blocks: Block[] = []
  for (const [index, line] of lines.entries()) {
    const size = tokens[index] ?? 0
    let block = blocks.at(-1)
    const full =
      block !== undefined &&
      (block.tokens + size > maxTokens || (timed ? line.end - block.start > BLOCK_SECONDS : block.tokens >= BLOCK_TOKENS))
    if (block === undefined || full) {
      block = { from: index, to: index, start: line.start, end: line.end, tokens: 0 }
      blocks.push(block)
    }
    block.to = index + 1
    block.end = Math.max(block.end, line.end)
    block.tokens += size
  }
  return blocks
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/** A text's words, lowercased; single letters and digits carry no topic. */
export function wordsOf(text: string): string[] {
  const words: string[] = []
  for (const part of segmenter.segment(text.toLowerCase())) {
    if (!part.isWordLike) continue
    if (part.segment.length < 2 && !/\p{Script=Han}/u.test(part.segment)) continue
    if (/^\d+$/.test(part.segment)) continue
    words.push(part.segment)
  }
  return words
}

type Vector = Map<string, number>

/**
 * Term counts per block, weighted by how rare the word is across the meeting (tf-idf). Words in
 * every block ("the", "okay", the project's name) weigh nothing, in any language, with no
 * stopword list.
 */
function vectorsOf(blocks: Block[], lines: NotesLine[]): Vector[] {
  const counts = blocks.map((block) => {
    const terms: Vector = new Map()
    for (const line of lines.slice(block.from, block.to)) {
      for (const word of wordsOf(line.text)) terms.set(word, (terms.get(word) ?? 0) + 1)
    }
    return terms
  })
  const seen = new Map<string, number>()
  for (const terms of counts) for (const word of terms.keys()) seen.set(word, (seen.get(word) ?? 0) + 1)
  return counts.map((terms) => {
    const weighted: Vector = new Map()
    for (const [word, count] of terms) {
      const weight = count * Math.log(counts.length / (seen.get(word) ?? 1))
      if (weight > 0) weighted.set(word, weight)
    }
    return weighted
  })
}

function sum(vectors: Vector[]): Vector {
  const total: Vector = new Map()
  for (const vector of vectors) for (const [word, value] of vector) total.set(word, (total.get(word) ?? 0) + value)
  return total
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0
  let aa = 0
  let bb = 0
  for (const [word, value] of a) {
    aa += value * value
    dot += value * (b.get(word) ?? 0)
  }
  for (const value of b.values()) bb += value * value
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

/**
 * For each gap between blocks (index g sits before block g; 0 and the end are no gap), how much
 * the talk changes there, from 0 (no dip) to 1 (the deepest dip in the meeting).
 */
export function topicShifts(vectors: Vector[]): number[] {
  const gaps = vectors.length
  const similarity = Array.from({ length: gaps }, (_, gap) =>
    gap === 0 ? 1 : cosine(sum(vectors.slice(Math.max(0, gap - WINDOW_BLOCKS), gap)), sum(vectors.slice(gap, gap + WINDOW_BLOCKS)))
  )
  const at = (gap: number): number => similarity[gap] ?? 0
  const depths = similarity.map((value, gap) => {
    if (gap === 0) return 0
    let left = gap
    while (left > 1 && at(left - 1) >= at(left)) left--
    let right = gap
    while (right < gaps - 1 && at(right + 1) >= at(right)) right++
    return at(left) - value + (at(right) - value)
  })
  const deepest = Math.max(0, ...depths)
  return deepest > 0 ? depths.map((depth) => depth / deepest) : depths
}

/**
 * The meeting's sections, in order: every line in exactly one, each within `room` tokens.
 * A transcript that fits one section still comes back as one.
 */
export function splitSections(input: NotesLine[], { room, count }: SectionOptions): NotesLine[][] {
  // Half the room per block, so a single block always fits a section.
  const blockRoom = Math.max(1, Math.floor(room / 2))
  const lines = fitLines(input, blockRoom, count)
  if (!lines.length) return []
  const tokens = lines.map((line) => count(lineText(line)) + 1)
  const timed = lines.some((line) => line.end > line.start)
  const blocks = blocksOf(lines, tokens, timed, blockRoom)
  const shifts = topicShifts(vectorsOf(blocks, lines))
  const before = [0]
  for (const block of blocks) before.push((before.at(-1) ?? 0) + block.tokens)
  const sizeOf = (from: number, to: number): number => {
    const used = (before[to] ?? 0) - (before[from] ?? 0)
    if (!timed) return used / TOKENS_PER_SECOND
    return (blocks[to - 1]?.end ?? 0) - (blocks[from]?.start ?? 0)
  }

  // best[j]: the lowest cost of cutting blocks [0, j); from[j]: where its last section starts.
  const best = [0]
  const from = [0]
  for (let to = 1; to <= blocks.length; to++) {
    let lowest = Infinity
    let start = to - 1
    for (let at = to - 1; at >= 0; at--) {
      const used = (before[to] ?? 0) - (before[at] ?? 0)
      const size = sizeOf(at, to)
      // One block always fits; past that, a section stops growing at either limit.
      if (at < to - 1 && (used > room || size > MAX_SECONDS)) break
      const off = (size - TARGET_SECONDS) / TARGET_SECONDS
      const cost = (best[at] ?? 0) + LENGTH_WEIGHT * off * off - (at > 0 ? (shifts[at] ?? 0) : 0)
      if (cost < lowest) {
        lowest = cost
        start = at
      }
    }
    best.push(lowest)
    from.push(start)
  }

  const cuts: number[] = []
  for (let to = blocks.length; to > 0; to = from[to] ?? 0) cuts.unshift(to)
  let previous = 0
  return cuts.map((cut) => {
    const first = blocks[previous]?.from ?? 0
    const last = blocks[cut - 1]?.to ?? lines.length
    previous = cut
    return lines.slice(first, last)
  })
}

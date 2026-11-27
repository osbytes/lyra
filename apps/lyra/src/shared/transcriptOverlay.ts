import { z } from 'zod'

/**
 * The user's edits to a transcript line, kept as an overlay on what the model heard. The raw
 * line (`original`) never changes once written; corrections, removals and highlights are ranges
 * over it, so the raw words are always one click away and an edit can be undone piece by piece.
 * The line's visible text is derived: `applyOverlay(original, edits)`.
 */

/** A range of the original line, as UTF-16 offsets: `[start, end)`. */
export type Span = { start: number; end: number }

const span = { start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }

export const TranscriptEdit = z.discriminatedUnion('kind', [
  /** The words in the range were heard wrong; `text` is what was said. An empty range inserts. */
  z.object({ kind: z.literal('replace'), ...span, text: z.string() }),
  /** The words in the range shouldn't be in the transcript (filler, crosstalk). */
  z.object({ kind: z.literal('delete'), ...span }),
  /** Marked as important. Doesn't change the text. */
  z.object({ kind: z.literal('highlight'), ...span })
])
export type TranscriptEdit = z.infer<typeof TranscriptEdit>

type TextEdit = Extract<TranscriptEdit, { kind: 'replace' | 'delete' }>

const isTextEdit = (edit: TranscriptEdit): edit is TextEdit => edit.kind !== 'highlight'
const byStart = (a: Span, b: Span): number => a.start - b.start || a.end - b.end
const overlaps = (a: Span, b: Span): boolean =>
  (a.start < b.end && b.start < a.end) ||
  // An insertion touches the range it sits inside (or on the edge of).
  (a.start === a.end && b.start <= a.start && a.start <= b.end) ||
  (b.start === b.end && a.start <= b.start && b.start <= a.end)

/** Reads edits stored in the document; anything malformed is dropped. */
export function readEdits(value: unknown, length: number): TranscriptEdit[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((item: unknown): TranscriptEdit[] => {
      if (!item || typeof item !== 'object') return []
      const { kind, start, end, text } = item as Record<string, unknown>
      if (typeof start !== 'number' || typeof end !== 'number') return []
      if (!(start >= 0 && start <= end && end <= length)) return []
      if (kind === 'replace' && typeof text === 'string') return [{ kind, start, end, text }]
      if (kind === 'delete' && end > start) return [{ kind, start, end }]
      if (kind === 'highlight' && end > start) return [{ kind, start, end }]
      return []
    })
    .sort(byStart)
}

/** The line as the user sees it: the original with replacements and removals applied. */
export function applyOverlay(original: string, edits: readonly TranscriptEdit[]): string {
  if (!edits.some(isTextEdit)) return original
  let out = ''
  let at = 0
  for (const edit of edits.filter(isTextEdit).sort(byStart)) {
    if (edit.start < at) continue
    out += original.slice(at, edit.start)
    if (edit.kind === 'replace') out += edit.text
    at = edit.end
  }
  out += original.slice(at)
  // Removing words leaves doubled or stray spaces around them.
  return out.replace(/ {2,}/g, ' ').replace(/ ([.,!?;:])/g, '$1').trim()
}

export const hasTextEdits = (edits: readonly TranscriptEdit[]): boolean => edits.some(isTextEdit)

/** One run of a rendered line. Offsets are into the original, for mapping a selection back. */
export type Piece =
  | (Span & { kind: 'raw'; text: string; highlight: boolean })
  | (Span & { kind: 'deleted'; text: string; highlight: boolean })
  | (Span & { kind: 'replaced'; text: string; original: string; highlight: boolean })

/** Splits a line into runs for drawing: raw words, removed words and corrections. */
export function overlayPieces(original: string, edits: readonly TranscriptEdit[]): Piece[] {
  const highlights = edits.filter((edit) => edit.kind === 'highlight')
  const lit = (span: Span): boolean => highlights.some((h) => overlaps(h, span))
  const pieces: Piece[] = []
  const raw = (start: number, end: number): void => {
    // Cut raw text at highlight edges so each run is wholly lit or not.
    const cuts = new Set([start, end])
    for (const h of highlights) {
      if (h.start > start && h.start < end) cuts.add(h.start)
      if (h.end > start && h.end < end) cuts.add(h.end)
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] ?? start
      const b = points[i + 1] ?? end
      if (b > a) pieces.push({ kind: 'raw', start: a, end: b, text: original.slice(a, b), highlight: lit({ start: a, end: b }) })
    }
  }
  let at = 0
  for (const edit of edits.filter(isTextEdit).sort(byStart)) {
    if (edit.start < at) continue
    raw(at, edit.start)
    const span = { start: edit.start, end: edit.end }
    const heard = original.slice(edit.start, edit.end)
    pieces.push(
      edit.kind === 'replace'
        ? { kind: 'replaced', ...span, text: edit.text, original: heard, highlight: lit(span) }
        : { kind: 'deleted', ...span, text: heard, highlight: lit(span) }
    )
    at = edit.end
  }
  raw(at, original.length)
  return pieces
}

/**
 * Grows a range to cover every correction or removal it touches, so a new edit replaces whole
 * edits rather than cutting one in half.
 */
export function expandToEdits(edits: readonly TranscriptEdit[], span: Span): Span {
  let { start, end } = span
  for (const edit of edits.filter(isTextEdit)) {
    if (overlaps(edit, { start, end })) {
      start = Math.min(start, edit.start)
      end = Math.max(end, edit.end)
    }
  }
  return { start, end }
}

/** What the user currently sees for a range of the original (after `expandToEdits`). */
export function visibleText(original: string, edits: readonly TranscriptEdit[], span: Span): string {
  const inside = edits
    .filter((edit) => isTextEdit(edit) && edit.start >= span.start && edit.end <= span.end)
    .map((edit) => ({ ...edit, start: edit.start - span.start, end: edit.end - span.start }))
  return applyOverlay(original.slice(span.start, span.end), inside)
}

function withTextEdit(
  edits: readonly TranscriptEdit[],
  span: Span,
  next: TextEdit | null
): TranscriptEdit[] {
  const kept = edits.filter((edit) => !isTextEdit(edit) || !overlaps(edit, span))
  return (next ? [...kept, next] : kept).sort(byStart)
}

/** Corrects a range: what was said there is `text`. Returns the line's new edits. */
export function correctRange(
  original: string,
  edits: readonly TranscriptEdit[],
  span: Span,
  text: string
): TranscriptEdit[] {
  const range = expandToEdits(edits, span)
  const said = text.replace(/\s+/g, ' ').trim()
  // Typing back exactly what was heard is a restore, not a correction.
  if (said === original.slice(range.start, range.end).trim()) return withTextEdit(edits, range, null)
  return withTextEdit(edits, range, { kind: 'replace', ...range, text: said })
}

/** Removes a range from the transcript (it stays visible, struck through). */
export function removeRange(edits: readonly TranscriptEdit[], span: Span): TranscriptEdit[] {
  const range = expandToEdits(edits, span)
  if (range.end <= range.start) return [...edits]
  return withTextEdit(edits, range, { kind: 'delete', ...range })
}

/** Puts back what was heard in a range: drops corrections, removals and highlights over it. */
export function restoreRange(edits: readonly TranscriptEdit[], span: Span): TranscriptEdit[] {
  return edits.filter((edit) => !overlaps(edit, span))
}

/** True when every character of the range is highlighted. */
export function isHighlighted(edits: readonly TranscriptEdit[], span: Span): boolean {
  let at = span.start
  for (const h of edits.filter((edit) => edit.kind === 'highlight').sort(byStart)) {
    if (h.start > at) break
    at = Math.max(at, h.end)
  }
  return at >= span.end
}

/** Highlights a range, or clears it when it is already highlighted throughout. */
export function toggleHighlight(edits: readonly TranscriptEdit[], span: Span): TranscriptEdit[] {
  if (span.end <= span.start) return [...edits]
  const others = edits.filter((edit) => edit.kind !== 'highlight')
  const highlights = edits.filter((edit) => edit.kind === 'highlight')
  if (isHighlighted(edits, span)) {
    // Cut the range out, keeping what lies either side of it.
    const left = highlights.flatMap((h): TranscriptEdit[] => {
      if (h.end <= span.start || h.start >= span.end) return [h]
      const parts: TranscriptEdit[] = []
      if (h.start < span.start) parts.push({ kind: 'highlight', start: h.start, end: span.start })
      if (h.end > span.end) parts.push({ kind: 'highlight', start: span.end, end: h.end })
      return parts
    })
    return [...others, ...left].sort(byStart)
  }
  // Merge with any highlight it touches.
  let { start, end } = span
  const apart = highlights.filter((h) => {
    if (h.end < start || h.start > end) return true
    start = Math.min(start, h.start)
    end = Math.max(end, h.end)
    return false
  })
  return [...others, ...apart, { kind: 'highlight' as const, start, end }].sort(byStart)
}

/**
 * Rewrites the whole line: the change from the original becomes one correction over the part
 * that differs, so the unchanged words stay raw. Highlights outside that part are kept.
 */
export function rewriteLine(
  original: string,
  edits: readonly TranscriptEdit[],
  next: string
): TranscriptEdit[] {
  const highlights = edits.filter((edit) => edit.kind === 'highlight')
  const said = next.replace(/\s+/g, ' ').trim()
  if (said === original) return highlights
  let start = 0
  const max = Math.min(original.length, said.length)
  while (start < max && original.charCodeAt(start) === said.charCodeAt(start)) start++
  let endOriginal = original.length
  let endNext = said.length
  while (endOriginal > start && endNext > start && original.charCodeAt(endOriginal - 1) === said.charCodeAt(endNext - 1)) {
    endOriginal--
    endNext--
  }
  // Snap to word edges, so the correction reads as whole words in the margin of the raw line.
  while (start > 0 && /\S/.test(original.charAt(start - 1))) start--
  while (endOriginal < original.length && /\S/.test(original.charAt(endOriginal))) {
    endOriginal++
    endNext++
  }
  const span = { start, end: endOriginal }
  const text = said.slice(start, Math.min(endNext, said.length)).trim()
  const edit: TextEdit =
    text || span.end === span.start ? { kind: 'replace', ...span, text } : { kind: 'delete', ...span }
  return [...highlights.filter((h) => !overlaps(h, span)), edit].sort(byStart)
}

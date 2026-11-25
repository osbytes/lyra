import { useEffect, useRef, useState } from 'react'
import type { TranscriptSegment } from '../../../shared/sessionDoc'
import {
  correctRange,
  expandToEdits,
  isHighlighted,
  overlayPieces,
  removeRange,
  restoreRange,
  toggleHighlight,
  visibleText,
  type Span,
  type TranscriptEdit
} from '../../../shared/transcriptOverlay'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { tip } from './Tooltip'

/**
 * Editing a locked transcript. Lines are drawn from what the model heard plus the user's
 * overlay (corrections, removals, highlights); nothing is typed into the raw words directly.
 * Selecting words shows a small toolbar, and right-click opens the same actions plus the
 * line's own, so every change is an explicit, reversible edit over the raw line.
 */

// --- Drawing a line -------------------------------------------------------------------------

/**
 * One line's words: raw text, removed words struck through, corrections marked. `id` lets the
 * line's row use the words as part of its accessible name; the words are read as they are.
 */
export function LineText({ line, id }: { line: TranscriptSegment; id?: string }) {
  const pieces = overlayPieces(line.original, line.edits)
  return (
    <p className="line-text" data-line={line.id} id={id}>
      {pieces.map((piece) => {
        const common = {
          key: `${piece.kind}:${String(piece.start)}:${String(piece.end)}`,
          'data-kind': piece.kind,
          'data-start': piece.start,
          'data-end': piece.end,
          className: piece.highlight ? 'hl' : undefined
        }
        if (piece.kind === 'replaced') {
          return (
            <ins {...common} {...tip(piece.original ? `Heard: “${piece.original}”` : 'Added')}>
              {piece.text}
            </ins>
          )
        }
        if (piece.kind === 'deleted') {
          return (
            <del {...common} {...tip('Removed from the transcript')}>
              {piece.text}
            </del>
          )
        }
        return <span {...common}>{piece.text}</span>
      })}
    </p>
  )
}

// --- Mapping a selection back to the raw line --------------------------------------------

export type LineSelection = { line: string; span: Span; rect: DOMRect }

function pieceOffset(node: Node, offset: number, side: 'start' | 'end'): { line: string; at: number } | null {
  const element = node instanceof Element ? node : node.parentElement
  const lineEl = element?.closest<HTMLElement>('[data-line]')
  const line = lineEl?.dataset.line
  if (!lineEl || !line) return null
  // The selection edge sits between pieces (on the line element itself).
  if (element === lineEl) {
    const before = lineEl.childNodes[offset - 1]
    const end = before instanceof HTMLElement ? Number(before.dataset.end) : 0
    return { line, at: Number.isFinite(end) ? end : 0 }
  }
  const piece = element?.closest<HTMLElement>('[data-kind]')
  if (!piece) return null
  const start = Number(piece.dataset.start)
  const end = Number(piece.dataset.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  // A correction is one unit: selecting into it takes all of it.
  if (piece.dataset.kind === 'replaced') return { line, at: side === 'start' ? start : end }
  const within = node === piece ? (offset > 0 ? end - start : 0) : offset
  return { line, at: Math.min(end, start + within) }
}

/** The selected words as a range of one line's original text; null across lines or when empty. */
export function readSelection(
  root: HTMLElement | null,
  lines: readonly TranscriptSegment[]
): LineSelection | null {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const from = pieceOffset(range.startContainer, range.startOffset, 'start')
  const to = pieceOffset(range.endContainer, range.endOffset, 'end')
  if (!from || from.line !== to?.line) return null
  const line = lines.find((entry) => entry.id === from.line)
  if (!line) return null
  // Double-click picks up the space after a word; edits read better on the words alone.
  let start = Math.min(from.at, to.at)
  let end = Math.max(from.at, to.at)
  while (start < end && /\s/.test(line.original.charAt(start))) start++
  while (end > start && /\s/.test(line.original.charAt(end - 1))) end--
  if (end <= start) return null
  return { line: line.id, span: { start, end }, rect: range.getBoundingClientRect() }
}

/** The correction or removal under the pointer, if any, as a range of the original. */
export function editAt(target: EventTarget | null): Span | null {
  if (!(target instanceof Element)) return null
  const piece = target.closest<HTMLElement>('[data-kind="replaced"], [data-kind="deleted"]')
  if (!piece) return null
  const start = Number(piece.dataset.start)
  const end = Number(piece.dataset.end)
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}

// --- Actions --------------------------------------------------------------------------------

export type Actions = {
  setEdits: (line: string, edits: TranscriptEdit[]) => void
  rewrite: (line: string) => void
  quote: (line: TranscriptSegment, text: string) => void
  copy: (text: string) => void
  listen: (line: TranscriptSegment) => void
  speaker: ((line: TranscriptSegment, anchor: DOMRect) => void) | null
}

const touchesEdit = (edits: readonly TranscriptEdit[], span: Span): boolean =>
  restoreRange(edits, span).length !== edits.length

const short = (text: string): string => (text.length > 28 ? `${text.slice(0, 27).trimEnd()}…` : text)

// --- Correcting a selection -----------------------------------------------------------------

/** A small field over the selection: type what was actually said. */
export function CorrectField({
  line,
  span,
  rect,
  onDone,
  onApply
}: {
  line: TranscriptSegment
  span: Span
  rect: DOMRect
  onDone: () => void
  onApply: (edits: TranscriptEdit[]) => void
}) {
  const range = expandToEdits(line.edits, span)
  const [value, setValue] = useState(() => visibleText(line.original, line.edits, range))
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.select()
  }, [])
  const heard = line.original.slice(range.start, range.end)
  return (
    <div className="picker-layer" onMouseDown={onDone}>
      <form
        className="correct-pop"
        style={{
          top: Math.min(rect.bottom + 8, window.innerHeight - 120),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 336))
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          onApply(correctRange(line.original, line.edits, range, value))
          onDone()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onDone()
          }
        }}
      >
        <input
          ref={input}
          type="text"
          value={value}
          aria-label="What was said"
          onChange={(event) => setValue(event.target.value)}
        />
        <small>
          Heard “{heard}” · <kbd>Enter</kbd> to correct, <kbd>Esc</kbd> to cancel
        </small>
      </form>
    </div>
  )
}

// --- Selection toolbar ----------------------------------------------------------------------

export function SelectionBar({
  line,
  selection,
  actions,
  onCorrect
}: {
  line: TranscriptSegment
  selection: LineSelection
  actions: Actions
  onCorrect: () => void
}) {
  const { span, rect } = selection
  const lit = isHighlighted(line.edits, span)
  const text = visibleText(line.original, line.edits, expandToEdits(line.edits, span))
  const top = rect.top - 44 < 8 ? rect.bottom + 8 : rect.top - 44
  return (
    <div
      className="selection-bar"
      role="toolbar"
      aria-label="Edit selected words"
      style={{ top, left: Math.max(8, Math.min(rect.left + rect.width / 2, window.innerWidth - 8)) }}
      // Keep the selection while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={onCorrect}>
        Correct
      </button>
      <button type="button" onClick={() => actions.setEdits(line.id, removeRange(line.edits, span))}>
        Remove
      </button>
      <button type="button" onClick={() => actions.setEdits(line.id, toggleHighlight(line.edits, span))}>
        {lit ? 'Unhighlight' : 'Highlight'}
      </button>
      <button type="button" onClick={() => actions.quote(line, text)}>
        Add to notes
      </button>
      {touchesEdit(line.edits, span) ? (
        <button type="button" onClick={() => actions.setEdits(line.id, restoreRange(line.edits, span))}>
          Restore
        </button>
      ) : null}
    </div>
  )
}

// --- Context menu ---------------------------------------------------------------------------

export type MenuRequest = {
  line: string
  /** Selected words in this line, if any. */
  span: Span | null
  /** The correction or removal right-clicked, if any. */
  edit: Span | null
  rect: DOMRect | null
  x: number
  y: number
}


export function LineMenu({
  line,
  request,
  actions,
  onCorrect,
  onClose
}: {
  line: TranscriptSegment
  request: MenuRequest
  actions: Actions
  onCorrect: (span: Span, rect: DOMRect) => void
  onClose: () => void
}) {
  const { span, edit } = request
  const items: MenuItem[] = []
  if (edit) {
    const heard = line.original.slice(edit.start, edit.end)
    items.push({
      label: heard ? <>Restore “{short(heard)}”</> : 'Remove added words',
      run: () =>
        actions.setEdits(
          line.id,
          line.edits.filter((e) => e.kind === 'highlight' || e.start !== edit.start || e.end !== edit.end)
        )
    })
  }
  if (span) {
    const text = visibleText(line.original, line.edits, expandToEdits(line.edits, span))
    const lit = isHighlighted(line.edits, span)
    items.push(
      { label: <>Correct “{short(text)}”…</>, run: () => onCorrect(span, request.rect ?? new DOMRect(request.x, request.y)) },
      { label: 'Remove from transcript', danger: true, run: () => actions.setEdits(line.id, removeRange(line.edits, span)) },
      { label: lit ? 'Remove highlight' : 'Highlight', run: () => actions.setEdits(line.id, toggleHighlight(line.edits, span)) },
      { label: 'Add selection to notes', run: () => actions.quote(line, text) },
      { label: 'Copy selection', run: () => actions.copy(text) }
    )
    if (touchesEdit(line.edits, span)) {
      items.push({ label: 'Restore what was heard', run: () => actions.setEdits(line.id, restoreRange(line.edits, span)) })
    }
    items.push('separator')
  }
  items.push({ label: 'Edit line…', run: () => actions.rewrite(line.id) })
  if (!span && line.original) {
    // The keyboard's way to highlight: without a mouse there's no word selection to act on.
    const whole = { start: 0, end: line.original.length }
    if (!isHighlighted(line.edits, whole)) {
      items.push({ label: 'Highlight line', run: () => actions.setEdits(line.id, toggleHighlight(line.edits, whole)) })
    }
  }
  const { speaker } = actions
  if (speaker && line.cluster) {
    items.push({ label: 'Who said this…', run: () => speaker(line, new DOMRect(request.x, request.y)) })
  }
  items.push(
    { label: 'Listen from here', run: () => actions.listen(line) },
    { label: 'Add line to notes', run: () => actions.quote(line, line.text) },
    { label: 'Copy line', run: () => actions.copy(line.text) }
  )
  if (line.edited) {
    items.push({
      label: 'Restore original line',
      run: () => actions.setEdits(line.id, line.edits.filter((e) => e.kind === 'highlight'))
    })
  }
  if (line.edits.some((e) => e.kind === 'highlight')) {
    items.push({
      label: 'Clear highlights',
      run: () => actions.setEdits(line.id, line.edits.filter((e) => e.kind !== 'highlight'))
    })
  }
  if (items.at(-1) === 'separator') items.pop()
  return <ContextMenu x={request.x} y={request.y} label="Transcript line" items={items} onClose={onClose} />
}

/** Rewriting a whole line in place; stored as a correction over the words that changed. */
export function LineRewrite({
  line,
  onDone,
  onSave
}: {
  line: TranscriptSegment
  onDone: () => void
  onSave: (text: string) => void
}) {
  const [value, setValue] = useState(line.text)
  const area = useRef<HTMLTextAreaElement>(null)
  // Escape and Enter finish the edit; the blur that follows unmounting mustn't save again.
  const finished = useRef(false)
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const finish = (keep: boolean): void => {
    if (finished.current) return
    finished.current = true
    if (keep && value.trim() !== line.text) onSave(value)
    onDone()
  }
  return (
    <div className="line-rewrite">
      <textarea
        ref={area}
        className="line-edit"
        value={value}
        rows={1}
        spellCheck
        aria-label="Edit line"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }}
      />
      <small>
        Heard: “{line.original}” · <kbd>Enter</kbd> to save, <kbd>Esc</kbd> to cancel
      </small>
    </div>
  )
}

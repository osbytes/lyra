import { describe, expect, it } from 'vitest'
import {
  applyOverlay,
  correctRange,
  expandToEdits,
  hasTextEdits,
  isHighlighted,
  overlayPieces,
  readEdits,
  removeRange,
  restoreRange,
  rewriteLine,
  toggleHighlight,
  visibleText,
  type TranscriptEdit
} from './transcriptOverlay'

// t h e _ c a t _ s a t _  o  n  _  t  h  e  _  m  a  t
// 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21
const LINE = 'the cat sat on the mat'
const CAT = { start: 4, end: 7 }
const SAT = { start: 8, end: 11 }
const MAT = { start: 19, end: 22 }

describe('readEdits', () => {
  it('keeps well-formed edits in order and drops the rest', () => {
    const stored: unknown = [
      { kind: 'delete', start: 8, end: 11 },
      { kind: 'replace', start: 4, end: 7, text: 'dog' },
      { kind: 'delete', start: 2, end: 2 },
      { kind: 'highlight', start: 5, end: 30 },
      { kind: 'replace', start: 0, end: 3 },
      { kind: 'replace', start: 7, end: 4, text: 'x' },
      { kind: 'bold', start: 0, end: 3 },
      'junk',
      null
    ]
    expect(readEdits(stored, LINE.length)).toEqual([
      { kind: 'replace', start: 4, end: 7, text: 'dog' },
      { kind: 'delete', start: 8, end: 11 }
    ])
    expect(readEdits('not a list', LINE.length)).toEqual([])
  })

  it('keeps an insertion (an empty replace)', () => {
    expect(readEdits([{ kind: 'replace', start: 3, end: 3, text: ' big' }], LINE.length)).toEqual([
      { kind: 'replace', start: 3, end: 3, text: ' big' }
    ])
  })
})

describe('applyOverlay', () => {
  it('applies corrections and removals, tidying the spaces a removal leaves', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'replace', ...CAT, text: 'dog' },
      { kind: 'delete', ...SAT }
    ]
    expect(applyOverlay(LINE, edits)).toBe('the dog on the mat')
  })

  it('pulls punctuation back to the word before a removal', () => {
    expect(applyOverlay('we ship it um.', [{ kind: 'delete', start: 11, end: 13 }])).toBe('we ship it.')
  })

  it('leaves the line alone for highlights only', () => {
    expect(applyOverlay(LINE, [{ kind: 'highlight', ...CAT }])).toBe(LINE)
    expect(hasTextEdits([{ kind: 'highlight', ...CAT }])).toBe(false)
  })

  it('skips an edit that overlaps one before it', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'replace', start: 4, end: 11, text: 'dog ran' },
      { kind: 'delete', start: 8, end: 14 }
    ]
    expect(applyOverlay(LINE, edits)).toBe('the dog ran on the mat')
  })

  it('inserts at an empty range', () => {
    expect(applyOverlay(LINE, [{ kind: 'replace', start: 3, end: 3, text: ' big' }])).toBe(
      'the big cat sat on the mat'
    )
  })
})

describe('overlayPieces', () => {
  it('splits raw text, corrections and highlights into runs over the original', () => {
    const pieces = overlayPieces('the cat sat', [
      { kind: 'replace', ...CAT, text: 'dog' },
      { kind: 'highlight', start: 0, end: 5 }
    ])
    expect(pieces).toEqual([
      { kind: 'raw', start: 0, end: 4, text: 'the ', highlight: true },
      { kind: 'replaced', start: 4, end: 7, text: 'dog', original: 'cat', highlight: true },
      { kind: 'raw', start: 7, end: 11, text: ' sat', highlight: false }
    ])
  })

  it('cuts raw text at highlight edges', () => {
    expect(overlayPieces('the cat sat', [{ kind: 'highlight', ...CAT }])).toEqual([
      { kind: 'raw', start: 0, end: 4, text: 'the ', highlight: false },
      { kind: 'raw', start: 4, end: 7, text: 'cat', highlight: true },
      { kind: 'raw', start: 7, end: 11, text: ' sat', highlight: false }
    ])
  })

  it('shows removed words as deleted runs', () => {
    expect(overlayPieces('the cat sat', [{ kind: 'delete', ...SAT }])).toEqual([
      { kind: 'raw', start: 0, end: 8, text: 'the cat ', highlight: false },
      { kind: 'deleted', start: 8, end: 11, text: 'sat', highlight: false }
    ])
  })
})

describe('expandToEdits', () => {
  it('grows a range over every text edit it touches', () => {
    expect(expandToEdits([{ kind: 'replace', ...CAT, text: 'dog' }], { start: 5, end: 9 })).toEqual({
      start: 4,
      end: 9
    })
  })

  it('takes in an insertion on the range edge, but not a highlight', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'replace', start: 8, end: 8, text: 'x' },
      { kind: 'highlight', start: 0, end: 22 }
    ]
    expect(expandToEdits(edits, { start: 8, end: 10 })).toEqual({ start: 8, end: 10 })
  })
})

describe('visibleText', () => {
  it('shows a range as the user sees it', () => {
    const edits: TranscriptEdit[] = [{ kind: 'replace', ...CAT, text: 'dog' }]
    expect(visibleText(LINE, edits, { start: 4, end: 11 })).toBe('dog sat')
  })
})

describe('correctRange', () => {
  it('stores a correction with its text tidied', () => {
    expect(correctRange(LINE, [], CAT, '  big   dog ')).toEqual([
      { kind: 'replace', ...CAT, text: 'big dog' }
    ])
  })

  it('swallows a correction it overlaps, so edits never cut each other in half', () => {
    const first = correctRange(LINE, [], CAT, 'dog')
    expect(correctRange(LINE, first, { start: 6, end: 11 }, 'dog ran')).toEqual([
      { kind: 'replace', start: 4, end: 11, text: 'dog ran' }
    ])
  })

  it('reads typing back what was heard as a restore', () => {
    const edits = correctRange(LINE, [], CAT, 'dog')
    expect(correctRange(LINE, edits, CAT, 'cat')).toEqual([])
  })
})

describe('removeRange and restoreRange', () => {
  it('removes a range and puts it back', () => {
    const removed = removeRange([], SAT)
    expect(removed).toEqual([{ kind: 'delete', ...SAT }])
    expect(restoreRange(removed, { start: 9, end: 10 })).toEqual([])
  })

  it('ignores an empty range', () => {
    expect(removeRange([], { start: 3, end: 3 })).toEqual([])
  })

  it('restores only what the range touches, highlights included', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'highlight', start: 0, end: 2 },
      { kind: 'replace', ...CAT, text: 'dog' },
      { kind: 'highlight', start: 5, end: 6 },
      { kind: 'delete', ...SAT }
    ]
    expect(restoreRange(edits, { start: 4, end: 6 })).toEqual([
      { kind: 'highlight', start: 0, end: 2 },
      { kind: 'delete', ...SAT }
    ])
  })
})

describe('highlights', () => {
  it('counts touching highlights as one run', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'highlight', start: 0, end: 3 },
      { kind: 'highlight', start: 3, end: 6 }
    ]
    expect(isHighlighted(edits, { start: 1, end: 5 })).toBe(true)
    expect(isHighlighted([{ kind: 'highlight', start: 0, end: 3 }], { start: 1, end: 5 })).toBe(false)
  })

  it('sees a gap between highlights', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'highlight', start: 0, end: 3 },
      { kind: 'highlight', start: 4, end: 6 }
    ]
    expect(isHighlighted(edits, { start: 1, end: 5 })).toBe(false)
  })

  it('toggles: adds, cuts a hole in, and merges with what it touches', () => {
    const on = toggleHighlight([], { start: 2, end: 5 })
    expect(on).toEqual([{ kind: 'highlight', start: 2, end: 5 }])
    expect(toggleHighlight(on, { start: 3, end: 4 })).toEqual([
      { kind: 'highlight', start: 2, end: 3 },
      { kind: 'highlight', start: 4, end: 5 }
    ])
    expect(toggleHighlight([{ kind: 'highlight', start: 0, end: 2 }], { start: 2, end: 4 })).toEqual([
      { kind: 'highlight', start: 0, end: 4 }
    ])
  })

  it('keeps text edits when toggling and ignores an empty range', () => {
    const edits: TranscriptEdit[] = [{ kind: 'delete', ...SAT }]
    expect(toggleHighlight(edits, { start: 1, end: 1 })).toEqual(edits)
    expect(toggleHighlight(edits, MAT)).toEqual([
      { kind: 'delete', ...SAT },
      { kind: 'highlight', ...MAT }
    ])
  })
})

describe('rewriteLine', () => {
  it('turns a rewrite into one correction over the changed word', () => {
    expect(rewriteLine(LINE, [], 'the dog sat on the mat')).toEqual([
      { kind: 'replace', ...CAT, text: 'dog' }
    ])
  })

  it('snaps the correction to whole words', () => {
    // only "re" → "ir" differs, but the correction covers the word "there"
    expect(rewriteLine('hello there', [], 'hello their')).toEqual([
      { kind: 'replace', start: 6, end: 11, text: 'their' }
    ])
  })

  it('produces the rewritten text when applied', () => {
    for (const next of ['the cat on the mat', 'a cat sat on the mat', 'the cat sat on the mat today']) {
      expect(applyOverlay(LINE, rewriteLine(LINE, [], next))).toBe(next)
    }
  })

  it('keeps highlights outside the change and drops those inside it', () => {
    const highlights: TranscriptEdit[] = [
      { kind: 'highlight', ...CAT },
      { kind: 'highlight', ...MAT }
    ]
    expect(rewriteLine(LINE, highlights, 'the dog sat on the mat')).toEqual([
      { kind: 'replace', ...CAT, text: 'dog' },
      { kind: 'highlight', ...MAT }
    ])
  })

  it('goes back to the raw line when the rewrite matches it', () => {
    const edits: TranscriptEdit[] = [
      { kind: 'replace', ...CAT, text: 'dog' },
      { kind: 'highlight', ...MAT }
    ]
    expect(rewriteLine(LINE, edits, `  ${LINE} `)).toEqual([{ kind: 'highlight', ...MAT }])
  })
})

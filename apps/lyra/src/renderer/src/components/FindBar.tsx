import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { keyLabel } from '../lib/format'
import { cn } from '../lib/utils'
import { ChevronDownIcon, CloseIcon, SearchIcon } from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'

type Props = {
  /** What to search: the open session's notes, summary and transcript. */
  root: RefObject<HTMLElement | null>
  /** Text to start with (the selection when Find opened). */
  initial: string
  /** Changes when Find is asked for again while open, to refocus and select the field. */
  request: number
  onClose: () => void
}

const ALL = 'lyra-find'
const CURRENT = 'lyra-find-current'

/** Text nodes the reader sees, in order, with where each starts in the joined text. */
function textOf(root: HTMLElement): { text: string; nodes: { node: Text; start: number }[] } {
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  let block: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-find-skip]')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data) continue
    // A break between blocks, so a match never runs from one paragraph or line into the next.
    const owner = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, .editor-mirror, .gutter') ?? null
    if (owner !== block && text) text += '\n'
    block = owner
    nodes.push({ node, start: text.length })
    text += node.data
  }
  return { text, nodes }
}

/** Every case-insensitive occurrence of `needle` under `root`, as ranges. */
function findRanges(root: HTMLElement, needle: string): Range[] {
  if (!needle) return []
  const { text, nodes } = textOf(root)
  const haystack = text.toLowerCase()
  const want = needle.toLowerCase()
  const at = (offset: number, end: boolean): { node: Text; offset: number } | null => {
    // The last node starting at or before `offset` (for an end, strictly before it).
    let found: { node: Text; start: number } | undefined
    for (const entry of nodes) {
      if (end ? entry.start < offset : entry.start <= offset) found = entry
      else break
    }
    if (!found) return null
    const local = offset - found.start
    return local <= found.node.data.length ? { node: found.node, offset: local } : null
  }
  const ranges: Range[] = []
  for (let index = haystack.indexOf(want); index !== -1; index = haystack.indexOf(want, index + want.length)) {
    const start = at(index, false)
    const end = at(index + want.length, true)
    if (!start || !end) continue
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    ranges.push(range)
  }
  return ranges
}

function clearHighlights(): void {
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** Scrolls the match into the middle of whichever pane holds it. */
function reveal(range: Range): void {
  const element = range.startContainer.parentElement
  if (!element) return
  const box = range.getBoundingClientRect()
  const pane = element.closest('.scroller')
  const view = pane?.getBoundingClientRect()
  if (pane && view && box.top >= view.top + 24 && box.bottom <= view.bottom - 24) return
  // Instant, like a browser's find: stepping through matches with Enter shouldn't wait on an
  // animation, and a smooth scroll makes each jump lag behind the highlight.
  element.scrollIntoView({ block: 'center', behavior: 'instant' })
}

/**
 * Find in the open session (Ctrl/Cmd+F): every match highlighted in place, Enter and Shift+Enter
 * to step through them. Highlights use the CSS Custom Highlight API, so the notes editor and the
 * transcript's DOM are never touched.
 */
export function FindBar({ root, initial, request, onClose }: Props) {
  const [query, setQuery] = useState(initial)
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const queryRef = useRef(query)
  queryRef.current = query

  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [request])

  const search = useCallback(
    (keepPlace: boolean) => {
      const el = root.current
      const next = el ? findRanges(el, queryRef.current.trim()) : []
      setRanges(next)
      setIndex((current) => (keepPlace ? Math.min(current, Math.max(0, next.length - 1)) : 0))
      // A new query brings its first match into view.
      const first = next[0]
      if (!keepPlace && first) reveal(first)
    },
    [root]
  )

  // A new query starts from the first match; content changing (new lines while recording,
  // typing in the notes) keeps the place.
  useEffect(() => {
    search(false)
  }, [query, search])

  useEffect(() => {
    const el = root.current
    if (!el) return
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => search(true))
    })
    observer.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [root, search])

  const current = ranges[index]
  useEffect(() => {
    if (!ranges.length) {
      clearHighlights()
      return
    }
    CSS.highlights.set(ALL, new Highlight(...ranges))
    if (current) CSS.highlights.set(CURRENT, new Highlight(current))
  }, [ranges, current])

  useEffect(() => clearHighlights, [])

  const step = (by: number): void => {
    if (!ranges.length) return
    const next = (index + by + ranges.length) % ranges.length
    setIndex(next)
    const range = ranges[next]
    if (range) reveal(range)
  }

  const label = query.trim()
    ? ranges.length
      ? `${String(index + 1)} of ${String(ranges.length)}`
      : 'No matches'
    : ''

  return (
    <div
      className="find-bar flex max-w-[520px] items-center gap-2 rounded-md border-(length:--border-width) border-border bg-popover px-2 py-1.5 shadow-md"
      role="search"
      aria-label="Find in session"
      data-find-skip
    >
      <SearchIcon className="shrink-0 text-text-3" />
      <input
        className="h-6 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-text-3"
        ref={input}
        type="text"
        value={query}
        placeholder="Find in session"
        aria-label="Find in session"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span
        className={cn('shrink-0 font-mono text-label tabular-nums text-text-3', query.trim() && !ranges.length && 'text-destructive')}
        aria-live="polite"
      >
        {label}
      </span>
      <Button
        type="button"
        variant="ghost" size="icon-sm" className="find-prev [&_svg]:rotate-180"
        aria-label="Previous match"
        disabled={!ranges.length}
        onClick={() => step(-1)}
        {...tip('Previous', keyLabel('Shift+Enter'))}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost" size="icon-sm"
        aria-label="Next match"
        disabled={!ranges.length}
        onClick={() => step(1)}
        {...tip('Next', keyLabel('Enter'))}
      >
        <ChevronDownIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Close find" onClick={onClose} {...tip('Close', keyLabel('Esc'))}>
        <CloseIcon />
      </Button>
    </div>
  )
}

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptSegment } from '../../../shared/sessionDoc'
import type { SummarySection } from '../../../shared/summarySections'
import { clockLabel as clock } from '../lib/format'
import { ChevronDownIcon } from './Icons'
import { tip } from './Tooltip'

/** The rail's own width (see `.toc-rail` in styles.css). */
const RAIL_WIDTH = 220
/** Space between the rail and whatever it sits beside. */
const RAIL_GAP = 24
/** A section is current once its first line is this close to the top of the view. */
const CURRENT_OFFSET = 96

function rowIn(root: HTMLElement | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null
}

export type SectionsNav = {
  sections: SummarySection[]
  /** Each section's first transcript line, by index. */
  firstLines: (string | null)[]
  /** The section on screen. */
  current: number
  /** 'rail' when the margin has room for it beside the speaker names; else a menu in the bar. */
  layout: 'rail' | 'menu'
  /** How far left of the transcript's text the rail sits, past the speaker names. */
  offset: number
  jump: (index: number) => void
}

/**
 * A long meeting's topic sections, from its summary, as a table of contents for the transcript
 * they index: where it fits, which one is on screen, and jumping to one. `scroller` is the
 * transcript's scroll area.
 */
export function useSectionsNav(
  sections: SummarySection[],
  transcript: TranscriptSegment[],
  scroller: RefObject<HTMLElement | null>
): SectionsNav {
  const [layout, setLayout] = useState<'rail' | 'menu'>('menu')
  const [offset, setOffset] = useState(RAIL_GAP)
  const [current, setCurrent] = useState(0)
  const any = sections.length > 0

  // Section times are whole seconds (the summary's clock), so a line is compared the same way.
  const firstLines = useMemo(
    () =>
      sections.map(
        (section) => (transcript.find((line) => Math.floor(line.start) >= section.start) ?? transcript.at(-1))?.id ?? null
      ),
    [sections, transcript]
  )

  // The margin left of the transcript, less the speaker names when they hang there, decides
  // whether the rail fits.
  useEffect(() => {
    const view = scroller.current
    if (!view || !any) return
    const measure = (): void => {
      const text = view.querySelector<HTMLElement>('.transcript')
      if (!text) return
      const left = text.getBoundingClientRect().left
      const room = left - view.getBoundingClientRect().left
      const gutter = view.querySelector<HTMLElement>('.gutter')
      const hangs = gutter !== null && getComputedStyle(gutter).position === 'absolute'
      const names = hangs ? left - gutter.getBoundingClientRect().left : 0
      const next = names + RAIL_GAP
      setOffset(next)
      setLayout(room >= next + RAIL_WIDTH + RAIL_GAP ? 'rail' : 'menu')
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    return () => observer.disconnect()
  }, [scroller, any, transcript.length])

  // The current section: the last one whose first line has reached the top of the view.
  useEffect(() => {
    const view = scroller.current
    if (!view || !any) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const top = view.getBoundingClientRect().top + CURRENT_OFFSET
      let found = 0
      firstLines.forEach((id, index) => {
        const row = id ? rowIn(view, id) : null
        if (row && row.getBoundingClientRect().top <= top) found = index
      })
      setCurrent(found)
    }
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    view.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      view.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, firstLines, any])

  const jump = (index: number): void => {
    const id = firstLines[index]
    const row = id ? rowIn(scroller.current, id) : null
    if (!row) return
    // Straight there: a table of contents is for getting somewhere, not watching the way.
    row.scrollIntoView({ block: 'start', behavior: 'instant' })
    row.focus({ preventScroll: true })
    setCurrent(index)
  }

  return { sections, firstLines, current, layout, offset, jump }
}

function SectionList({ nav, id, onPicked }: { nav: SectionsNav; id?: string; onPicked?: () => void }) {
  return (
    <ol id={id} className="toc-list">
      {nav.sections.map((section, index) => (
        <li key={`${String(section.start)}-${section.title}`}>
          <button
            type="button"
            className={index === nav.current ? 'toc-item is-current' : 'toc-item'}
            aria-current={index === nav.current ? 'location' : undefined}
            disabled={!nav.firstLines[index]}
            {...(section.summary ? tip(section.summary) : {})}
            onClick={() => {
              nav.jump(index)
              onPicked?.()
            }}
          >
            <span className="toc-time">{clock(section.start)}</span>
            <span className="toc-title">{section.title}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/** The sections in the transcript's left margin, staying in view as it scrolls. */
export function SectionsRail({ nav }: { nav: SectionsNav }) {
  if (!nav.sections.length || nav.layout !== 'rail') return null
  return (
    // Takes no height, so the transcript doesn't move; the rail hangs off it into the margin.
    <nav className="toc-anchor" aria-label="Sections">
      <div className="toc-rail" style={{ right: `calc(100% + ${String(nav.offset)}px)` }}>
        <h3 className="section-label">Sections</h3>
        <SectionList nav={nav} />
      </div>
    </nav>
  )
}

/** Without room for the rail: the current section in the transcript's bar, opening the list. */
export function SectionsMenu({ nav }: { nav: SectionsNav }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!nav.sections.length || nav.layout !== 'menu') return null
  const current = nav.sections[nav.current]
  return (
    <nav className="toc-menu" ref={root} aria-label="Sections">
      <button
        type="button"
        className="toc-toggle"
        aria-expanded={open}
        aria-controls={listId}
        {...tip('Sections')}
        onClick={() => setOpen((on) => !on)}
      >
        <span className="toc-toggle-title">{current?.title ?? 'Sections'}</span>
        <span className="toc-toggle-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <div className="toc-popover">
          <SectionList nav={nav} id={listId} onPicked={() => setOpen(false)} />
        </div>
      ) : null}
    </nav>
  )
}

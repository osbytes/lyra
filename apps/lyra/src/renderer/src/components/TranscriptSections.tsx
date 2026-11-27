import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { TranscriptSegment } from '../../../shared/sessionDoc'
import type { SummarySection } from '../../../shared/summarySections'
import { drawAttention } from '../lib/motion'

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
    drawAttention(row)
    setCurrent(index)
  }

  return { sections, firstLines, current, jump }
}

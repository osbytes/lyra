import { useId, useState } from 'react'
import { SECTIONS_HEADING } from '../../../shared/summarySections'
import { cn } from '../lib/utils'
import { ChevronDownIcon } from './Icons'
import { SummaryButton } from './SummaryButton'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'

/** The section headings `renderNotes` writes (src/main/meeting/notesFormat.ts). */
const HEADINGS = new Set(['Summary', SECTIONS_HEADING, 'Decisions', 'Action items', 'Open questions'])

/** Whether the summary card is folded: one choice for every session, kept across launches. */
const COLLAPSED_KEY = 'lyra.summaryCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

type Item = { text: string; line: number; done: boolean | null }
type Section = { heading: string | null; paragraphs: string[]; items: Item[] }

/**
 * Reads the summary's plain-text format back into sections. Text that isn't in that format
 * (an older file, or the user's own rewrite) still reads as paragraphs and bullets.
 */
function parseSummary(text: string): Section[] {
  const sections: Section[] = []
  let current: Section = { heading: null, paragraphs: [], items: [] }
  text.split('\n').forEach((raw, line) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (HEADINGS.has(trimmed)) {
      sections.push(current)
      current = { heading: trimmed, paragraphs: [], items: [] }
      return
    }
    const task = /^[-*] \[([ xX])\] (.*)$/.exec(trimmed)
    if (task) {
      current.items.push({ text: task[2] ?? '', line, done: task[1] !== ' ' })
      return
    }
    const bullet = /^[-*] (.*)$/.exec(trimmed)
    if (bullet) {
      // The writer says "None" for an empty section; an empty section isn't shown at all.
      const item = bullet[1] ?? ''
      if (item !== 'None') current.items.push({ text: item, line, done: null })
      return
    }
    current.paragraphs.push(trimmed)
  })
  sections.push(current)
  // The transcript shows the sections as its table of contents (TranscriptSections.tsx).
  return sections.filter(
    (section) => section.heading !== SECTIONS_HEADING && (section.paragraphs.length > 0 || section.items.length > 0)
  )
}

/** What a folded summary counts each list as: [one, many]. */
const COUNTED: Record<string, readonly [string, string]> = {
  Decisions: ['decision', 'decisions'],
  'Action items': ['action item', 'action items'],
  'Open questions': ['open question', 'open questions']
}

/** The folded summary's footer: "2 decisions · 1 of 3 action items done · 1 open question". */
function countsOf(sections: Section[]): string[] {
  return sections.flatMap((section) => {
    const words = section.heading ? COUNTED[section.heading] : undefined
    const total = section.items.length
    if (!words || !total) return []
    const noun = total === 1 ? words[0] : words[1]
    const tasks = section.items.filter((item) => item.done !== null)
    const done = tasks.filter((item) => item.done).length
    return [tasks.length && done ? `${String(done)} of ${String(total)} ${noun} done` : `${String(total)} ${noun}`]
  })
}

/** "Dana: port tokens" → the owner (a short name before a colon) and the task. */
function splitOwner(text: string): { owner: string | null; text: string } {
  const at = text.indexOf(': ')
  return at > 0 && at <= 40 ? { owner: text.slice(0, at), text: text.slice(at + 2) } : { owner: null, text }
}

/** An owner, as a small tag at the right of the item. */
function Owner({ name }: { name: string }) {
  return (
    <span className="mt-px shrink-0 rounded-full border-(length:--border-width) border-border bg-muted px-1.5 text-[11px] leading-4 font-medium text-text-2">
      {name}
    </span>
  )
}

/** Past this, the overview folds to five lines with a Show more. */
const LONG_OVERVIEW = 360

/** A folded summary: its first lines, clamped, and how many of each list it holds. */
function Folded({ sections, onOpen }: { sections: Section[]; onOpen: () => void }) {
  const lead = sections.find((section) => section.paragraphs.length)?.paragraphs.join(' ') ?? ''
  const counts = countsOf(sections)
  if (!lead && !counts.length) return null
  return (
    // The header's button is the keyboard way in; this is a larger target for the pointer.
    <div className="summary-folded grid cursor-pointer gap-1" onClick={onOpen}>
      {lead ? <p className="m-0 line-clamp-2 font-serif text-[15px] leading-6">{lead}</p> : null}
      {counts.length ? <p className="m-0 text-label text-text-3">{counts.join(' · ')}</p> : null}
    </div>
  )
}

type Props = {
  pageId: string
  value: string
  onChange: (value: string) => void
  /** Whether summaries can be written (an engine is chosen in Settings), so Rewrite is offered. */
  canRewrite: boolean
}

/**
 * The generated summary, read as sections and checklists. It's the model's writing, so it isn't
 * edited here (Rewrite asks for a new one); ticking an action item marks that one line done.
 * The header folds it away.
 */
export function Summary({ pageId, value, onChange, canRewrite }: Props) {
  const [more, setMore] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const bodyId = useId()

  const fold = (): void => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // Storage can be unavailable; the card still folds for this session.
    }
  }

  const toggle = (line: number): void => {
    const lines = value.split('\n')
    const text = lines[line]
    if (text === undefined) return
    lines[line] = text.replace(/\[([ xX])\]/, (box) => (box === '[ ]' ? '[x]' : '[ ]'))
    onChange(lines.join('\n'))
  }

  const sections = parseSummary(value)
  return (
    <section
      className={cn(
        'summary grid min-w-0 gap-3',
        collapsed && 'is-collapsed'
      )}
      aria-label="Summary"
    >
      {/* Where it was written is said once, in the session header. */}
      <header className="flex min-w-0 items-center gap-2">
        <button
          className="summary-fold -ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-xs px-1 focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={fold}
        >
          <ChevronDownIcon className={cn('shrink-0 text-text-3 transition-transform duration-[200ms]', collapsed && '-rotate-90')} />
          <h2 className="m-0 text-title-2 font-semibold">Summary</h2>
        </button>
        {collapsed ? null : (
          <span className="summary-tools ml-auto flex shrink-0 items-center gap-0.5">
            {canRewrite ? <SummaryButton pageId={pageId} hasSummary size="sm" /> : null}
          </span>
        )}
      </header>
      {collapsed ? (
        <Folded sections={sections} onOpen={fold} />
      ) : (
        <div className="summary-body grid gap-4" id={bodyId}>
          {sections.map((section, index) => {
            const overview = !section.heading || section.heading === 'Summary'
            const long = overview && section.paragraphs.join(' ').length > LONG_OVERVIEW
            return (
              <div
                className={cn('summary-section grid gap-2', !overview && 'border-t border-border pt-3.5')}
                key={`${section.heading ?? ''}-${String(index)}`}
              >
                {/* The card is already labeled Summary; its own heading would say it twice. */}
                {!overview ? (
                  <h3 className="m-0 flex items-center gap-1.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">
                    {section.heading}
                    {section.items.length ? (
                      <span className="font-mono tracking-normal">{section.items.length}</span>
                    ) : null}
                  </h3>
                ) : null}
                {section.paragraphs.length ? (
                  <div className={cn('grid gap-2', long && !more && 'line-clamp-5')}>
                    {section.paragraphs.map((paragraph, at) => (
                      <p key={at} className="m-0 font-serif text-[15px] leading-6 text-foreground">
                        {paragraph}
                      </p>
                    ))}
                  </div>
                ) : null}
                {long ? (
                  <Button variant="link" size="sm" className="h-auto justify-self-start" onClick={() => setMore((open) => !open)}>
                    {more ? 'Show less' : 'Show more'}
                  </Button>
                ) : null}
                {section.items.length ? (
                  <ul className="m-0 grid list-none gap-0.5 p-0">
                    {section.items.map((item) => {
                      const { owner, text } = splitOwner(item.text)
                      return item.done === null ? (
                        <li key={item.line} className="flex items-start gap-2.5 py-1 text-body-sm leading-5">
                          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-text-3" aria-hidden="true" />
                          <span className="min-w-0 flex-1">{text}</span>
                          {owner ? <Owner name={owner} /> : null}
                        </li>
                      ) : (
                        <li key={item.line} className={cn('summary-task', item.done && 'done')}>
                          <label className="-mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-sm px-1.5 py-1 text-body-sm leading-5 hover:bg-accent">
                            <Checkbox
                              className="mt-0.5"
                              checked={item.done}
                              aria-label={item.text}
                              onCheckedChange={() => toggle(item.line)}
                            />
                            <span className={cn('min-w-0 flex-1', item.done && 'text-text-3 line-through')}>{text}</span>
                            {owner ? <Owner name={owner} /> : null}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

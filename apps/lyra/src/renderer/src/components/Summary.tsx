import { useEffect, useId, useRef, useState } from 'react'
import { SECTIONS_HEADING } from '../../../shared/summarySections'
import { Editor } from './Editor'
import { ChevronDownIcon } from './Icons'
import { SummaryButton } from './SummaryButton'

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

/** "Dana: port tokens" → the owner in bold, when the part before the colon is a short name. */
function ItemText({ text }: { text: string }) {
  const at = text.indexOf(': ')
  if (at <= 0 || at > 40) return <>{text}</>
  return (
    <>
      <b>{text.slice(0, at)}</b>
      {text.slice(at)}
    </>
  )
}

/** A folded summary: its first lines, clamped, and how many of each list it holds. */
function Folded({ sections, onOpen }: { sections: Section[]; onOpen: () => void }) {
  const lead = sections.find((section) => section.paragraphs.length)?.paragraphs.join(' ') ?? ''
  const counts = countsOf(sections)
  if (!lead && !counts.length) return null
  return (
    // The header's button is the keyboard way in; this is a larger target for the pointer.
    <div className="summary-folded" onClick={onOpen}>
      {lead ? <p className="summary-lead">{lead}</p> : null}
      {counts.length ? <p className="summary-counts">{counts.join(' · ')}</p> : null}
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
 * The generated summary: read as sections and checklists, with Edit for the plain text the file
 * keeps. Ticking an action item edits that one line of the text. The header folds it away.
 */
export function Summary({ pageId, value, onChange, canRewrite }: Props) {
  const [editing, setEditing] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const field = useRef<HTMLTextAreaElement>(null)
  const bodyId = useId()
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  const fold = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (next) setEditing(false)
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

  return (
    <section className={collapsed ? 'summary is-collapsed' : 'summary'} aria-label="Summary">
      <header className="summary-head">
        <button
          className="summary-fold"
          type="button"
          aria-expanded={!collapsed}
          aria-controls={collapsed || editing ? undefined : bodyId}
          onClick={fold}
        >
          <span className="summary-chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
          <h2 className="section-label">Summary</h2>
        </button>
        <span className="summary-badge">Generated</span>
        {collapsed ? null : (
          <span className="summary-tools">
            {canRewrite && !editing ? <SummaryButton pageId={pageId} hasSummary className="btn ghost" /> : null}
            <button className="btn ghost" type="button" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          </span>
        )}
      </header>
      {collapsed ? (
        <Folded sections={parseSummary(value)} onOpen={fold} />
      ) : editing ? (
        <Editor
          ref={field}
          value={value}
          label="Generated summary"
          onChange={onChange}
        />
      ) : (
        <div className="summary-body" id={bodyId}>
          {parseSummary(value).map((section, index) => (
            <div className="summary-section" key={`${section.heading ?? ''}-${String(index)}`}>
              {/* The card is already labeled Summary; its own heading would say it twice. */}
              {section.heading && section.heading !== 'Summary' ? <h3>{section.heading}</h3> : null}
              {section.paragraphs.map((paragraph, at) => (
                <p key={at}>{paragraph}</p>
              ))}
              {section.items.length ? (
                <ul>
                  {section.items.map((item) =>
                    item.done === null ? (
                      <li key={item.line}>
                        <ItemText text={item.text} />
                      </li>
                    ) : (
                      <li key={item.line} className={item.done ? 'summary-task done' : 'summary-task'}>
                        <label>
                          <input type="checkbox" checked={item.done} onChange={() => toggle(item.line)} />
                          <span>
                            <ItemText text={item.text} />
                          </span>
                        </label>
                      </li>
                    )
                  )}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

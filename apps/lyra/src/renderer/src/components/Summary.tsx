import { useEffect, useRef, useState } from 'react'
import { Editor } from './Editor'

/** The section headings `renderNotes` writes (src/main/meeting/notesFormat.ts). */
const HEADINGS = new Set(['Summary', 'Decisions', 'Action items', 'Open questions'])

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
  return sections.filter((section) => section.paragraphs.length > 0 || section.items.length > 0)
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

type Props = {
  value: string
  onChange: (value: string) => void
}

/**
 * The generated summary: read as sections and checklists, with Edit for the plain text the file
 * keeps. Ticking an action item edits that one line of the text.
 */
export function Summary({ value, onChange }: Props) {
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  const toggle = (line: number): void => {
    const lines = value.split('\n')
    const text = lines[line]
    if (text === undefined) return
    lines[line] = text.replace(/\[([ xX])\]/, (box) => (box === '[ ]' ? '[x]' : '[ ]'))
    onChange(lines.join('\n'))
  }

  return (
    <section className="summary" aria-label="Summary">
      <header className="summary-head">
        <h2 className="section-label">Summary</h2>
        <span className="summary-badge">Generated</span>
        <button className="btn ghost summary-edit" type="button" onClick={() => setEditing((on) => !on)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </header>
      {editing ? (
        <Editor
          ref={field}
          value={value}
          ghost=""
          listening={false}
          label="Generated summary"
          onChange={onChange}
        />
      ) : (
        <div className="summary-body">
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

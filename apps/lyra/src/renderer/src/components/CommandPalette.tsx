import Fuse from 'fuse.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PageSummary, SearchField, SearchMatch } from '../../../shared/types'
import { useSearch } from '../hooks/useSearch'
import { clockLabel, relativeTime } from '../lib/format'
import { ScrollArea } from './Controls'
import { CommandIcon, NoteIcon, PeopleIcon, QuoteIcon, SearchIcon, TagIcon } from './Icons'

/** Sessions shown before anything is typed. */
const RECENT_COUNT = 8

export type PaletteCommand = {
  id: string
  label: string
  /** Other words that should find this command ("record" for "Continue recording"). */
  keywords?: string
  shortcut?: string
  icon?: ReactNode
  run: () => void
}

type Scope = 'all' | 'notes' | 'transcript'

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'notes', label: 'Notes' },
  { id: 'transcript', label: 'Transcripts' }
]

const FIELD_LABEL: Record<SearchField, string> = {
  title: 'Title',
  tags: 'Tag',
  summary: 'Summary',
  notes: 'Notes',
  transcript: 'Transcript'
}

type Item =
  | { kind: 'command'; key: string; command: PaletteCommand }
  | { kind: 'session'; key: string; page: PageSummary; matches: SearchMatch[] }

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  commands: PaletteCommand[]
  /** Opens a session; `line` scrolls its transcript to that line. */
  onOpen: (id: string, line: string | null) => void
  onClose: () => void
}

const inScope = (scope: Scope, match: SearchMatch): boolean =>
  scope === 'all' || (scope === 'transcript') === (match.field === 'transcript')

function sessionMeta(page: PageSummary): string {
  const parts = [relativeTime(page.updatedAt)]
  if (page.seconds) parts.push(clockLabel(page.seconds))
  if (page.speakers > 1) parts.push(`${String(page.speakers)} speakers`)
  return parts.join(' · ')
}

function Highlight({ parts }: { parts: SearchMatch['parts'] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
      )}
    </>
  )
}

function MatchLabel({ match }: { match: SearchMatch }) {
  return (
    <span className="palette-match-label">
      {match.field === 'transcript' ? <QuoteIcon /> : match.field === 'tags' ? <TagIcon /> : <NoteIcon />}
      {match.field === 'transcript' && match.speaker ? match.speaker : FIELD_LABEL[match.field]}
      {match.start !== null ? <span className="palette-time">{clockLabel(match.start)}</span> : null}
    </span>
  )
}

export function CommandPalette({ pages, activeId, commands, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [selected, setSelected] = useState(0)
  const search = useSearch(query)
  const list = useRef<HTMLDivElement>(null)
  const needle = query.trim()

  const commandFuse = useMemo(
    () => new Fuse(commands, { keys: ['label', 'keywords'], threshold: 0.4, ignoreLocation: true }),
    [commands]
  )

  const items = useMemo<Item[]>(() => {
    const commandItems = (needle ? commandFuse.search(needle).map((result) => result.item) : commands).map(
      (command): Item => ({ kind: 'command', key: `command:${command.id}`, command })
    )
    if (!needle) {
      const recent = pages
        .filter((page) => page.id !== activeId)
        .slice(0, RECENT_COUNT)
        .map((page): Item => ({ kind: 'session', key: `session:${page.id}`, page, matches: [] }))
      return scope === 'all' ? [...recent, ...commandItems] : recent
    }
    const sessions = search.hits.flatMap((hit): Item[] => {
      const matches = hit.matches.filter((match) => inScope(scope, match))
      // A title-only hit has no matches of its own; it belongs with the notes, not transcripts.
      const titleOnly = !hit.matches.length && scope !== 'transcript'
      if (!matches.length && !titleOnly) return []
      return [{ kind: 'session', key: `session:${hit.id}`, page: hit, matches }]
    })
    return scope === 'all' ? [...sessions, ...commandItems] : sessions
  }, [needle, commandFuse, commands, pages, activeId, scope, search.hits])

  useEffect(() => setSelected(0), [needle, scope])

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const active = items[selected]

  const choose = (item: Item | undefined, line: string | null = null): void => {
    if (!item) return
    onClose()
    if (item.kind === 'command') item.command.run()
    else onOpen(item.page.id, line ?? item.matches.find((match) => match.line)?.line ?? null)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!items.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSelected((index) => (index + step + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const at = SCOPES.findIndex((entry) => entry.id === scope)
      const next = SCOPES[(at + (event.shiftKey ? -1 : 1) + SCOPES.length) % SCOPES.length]
      if (next) setScope(next.id)
    }
  }

  const heading = (index: number, item: Item): ReactNode => {
    if (items[index - 1]?.kind === item.kind) return null
    const label = item.kind === 'command' ? 'Commands' : needle ? 'Sessions' : 'Recent'
    const count = item.kind === 'session' && needle ? items.filter((i) => i.kind === 'session').length : null
    return (
      <div className="palette-heading" role="presentation">
        {label}
        {count !== null ? <span className="palette-count">{count}</span> : null}
      </div>
    )
  }

  const empty = needle && !search.pending && search.query === needle && !items.length

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <label className="palette-input">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, transcripts and commands…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={active ? `palette-${active.key}` : undefined}
            spellCheck={false}
          />
          {search.pending ? <span className="palette-spinner" aria-label="Searching" /> : null}
        </label>
        <div className="palette-scopes" role="tablist" aria-label="Search in">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="filter-chip"
              aria-selected={scope === entry.id}
              aria-pressed={scope === entry.id}
              tabIndex={-1}
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="palette-body">
          <ScrollArea className="palette-results" ref={list}>
            <div id="palette-results" role="listbox" aria-label="Results">
              {items.map((item, index) => (
                <div key={item.key}>
                  {heading(index, item)}
                  <div
                    id={`palette-${item.key}`}
                    role="option"
                    aria-selected={index === selected}
                    className="palette-item"
                    onMouseMove={() => setSelected(index)}
                    onClick={() => choose(item)}
                  >
                    <span className="palette-icon">
                      {item.kind === 'command' ? (item.command.icon ?? <CommandIcon />) : <NoteIcon />}
                    </span>
                    {item.kind === 'command' ? (
                      <>
                        <span className="palette-title">{item.command.label}</span>
                        {item.command.shortcut ? <kbd>{item.command.shortcut}</kbd> : null}
                      </>
                    ) : (
                      <span className="palette-text">
                        <span className="palette-row">
                          <span className="palette-title">{item.page.title || 'Untitled'}</span>
                          <span className="palette-meta">{relativeTime(item.page.updatedAt)}</span>
                        </span>
                        {item.matches[0] ? (
                          <span className="palette-snippet">
                            <MatchLabel match={item.matches[0]} />
                            <span className="palette-snippet-text">
                              <Highlight parts={item.matches[0].parts} />
                            </span>
                          </span>
                        ) : item.page.preview ? (
                          <span className="palette-snippet">
                            <span className="palette-snippet-text">{item.page.preview}</span>
                          </span>
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {empty ? (
                <div className="palette-empty">
                  <SearchIcon />
                  <p>
                    Nothing matches “{needle}”
                    {scope === 'all' ? '' : ` in ${scope === 'notes' ? 'notes' : 'transcripts'}`}.
                  </p>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <aside className="palette-preview" aria-label="Preview">
            {active?.kind === 'session' ? (
              <>
                <h3>{active.page.title || 'Untitled'}</h3>
                <p className="palette-preview-meta">
                  {active.page.speakers > 1 ? <PeopleIcon /> : null}
                  {sessionMeta(active.page)}
                </p>
                {active.page.tags.length ? (
                  <div className="palette-tags">
                    {active.page.tags.map((tag) => (
                      <span key={tag} className="palette-tag">
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {active.matches.length ? (
                  <ul className="palette-matches">
                    {active.matches.map((match, index) => (
                      <li key={index}>
                        <button type="button" tabIndex={-1} onClick={() => choose(active, match.line)}>
                          <MatchLabel match={match} />
                          <span className="palette-match-text">
                            <Highlight parts={match.parts} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="palette-preview-text">{active.page.preview || 'No text yet.'}</p>
                )}
              </>
            ) : active?.kind === 'command' ? (
              <div className="palette-preview-command">
                <span className="palette-icon">{active.command.icon ?? <CommandIcon />}</span>
                <h3>{active.command.label}</h3>
                {active.command.shortcut ? <kbd>{active.command.shortcut}</kbd> : null}
              </div>
            ) : null}
          </aside>
        </div>
        <footer className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Tab</kbd> Filter
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </div>
    </div>
  )
}

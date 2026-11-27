import Fuse from 'fuse.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PageSummary, SearchField, SearchMatch } from '../../../shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useSearch } from '../hooks/useSearch'
import { clockLabel, relativeTime } from '../lib/format'
import { cn } from '../lib/utils'
import { ScrollArea } from './Controls'
import { CommandIcon, NoteIcon, PeopleIcon, QuoteIcon, SearchIcon, TagIcon } from './Icons'
import { Spinner } from './ui/status'

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
        part.hit ? (
          <mark key={index} className="rounded-[2px] bg-highlight px-px text-foreground hc:text-black">
            {part.text}
          </mark>
        ) : <span key={index}>{part.text}</span>
      )}
    </>
  )
}

function MatchLabel({ match }: { match: SearchMatch }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-label text-text-3 [&_svg]:size-3">
      {match.field === 'transcript' ? <QuoteIcon /> : match.field === 'tags' ? <TagIcon /> : <NoteIcon />}
      {match.field === 'transcript' && match.speaker ? match.speaker : FIELD_LABEL[match.field]}
      {match.start !== null ? <span className="font-mono text-brand-text">{clockLabel(match.start)}</span> : null}
    </span>
  )
}

export function CommandPalette({ pages, activeId, commands, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [selected, setSelected] = useState(0)
  const search = useSearch(query)
  const list = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useDialogFocus(dialog, true)
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
      <div
        className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase"
        role="presentation"
      >
        {label}
        {count !== null ? <span className="font-mono tracking-normal">{count}</span> : null}
      </div>
    )
  }

  const empty = needle && !search.pending && search.query === needle && !items.length

  const kbd = 'inline-block min-w-[1.6em] rounded-xs border-(length:--border-width) border-b-2 border-input bg-card px-[0.4em] text-center font-mono text-[11px] leading-4 text-foreground'

  return (
    // The launcher dims nothing: no scrim, elevation only.
    <div className="palette-backdrop fixed inset-0 z-[150] [-webkit-app-region:no-drag]" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="palette absolute top-[12vh] left-1/2 flex max-h-[72vh] w-[760px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border-(length:--border-width) border-border bg-popover text-body-sm text-popover-foreground shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <label className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchIcon className="shrink-0 text-text-3" />
          <input
            data-autofocus
            className="h-7 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-text-3"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, transcripts and actions"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={active ? `palette-${active.key}` : undefined}
            spellCheck={false}
          />
          {search.pending ? <Spinner className="size-3 text-text-3" role="status" aria-label="Searching" /> : null}
          <span className="palette-scopes ml-1 inline-flex gap-0.5 rounded-lg border-(length:--border-width) border-border bg-muted p-0.5" role="tablist" aria-label="Search in">
            {SCOPES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className={cn(
                  'h-[22px] rounded-sm px-2 text-label font-medium text-text-2 hover:text-foreground',
                  scope === entry.id && 'bg-card text-foreground shadow-sm outline-(length:--border-width) outline-border'
                )}
                aria-selected={scope === entry.id}
                aria-pressed={scope === entry.id}
                tabIndex={-1}
                onClick={() => setScope(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </span>
        </label>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
          <ScrollArea className="palette-results min-h-0 border-r border-border p-1" ref={list}>
            <div id="palette-results" role="listbox" aria-label="Results">
              {items.map((item, index) => (
                <div key={item.key}>
                  {heading(index, item)}
                  <div
                    id={`palette-${item.key}`}
                    role="option"
                    aria-selected={index === selected}
                    className={cn(
                      'palette-item flex min-h-[30px] cursor-default items-start gap-2 rounded-sm px-2 py-1.5',
                      index === selected && 'bg-brand-soft text-brand-text hc:outline-2 hc:outline-ring'
                    )}
                    onMouseMove={() => setSelected(index)}
                    onClick={() => choose(item)}
                  >
                    <span className="mt-0.5 grid shrink-0 place-items-center">
                      {item.kind === 'command' ? (item.command.icon ?? <CommandIcon />) : <NoteIcon />}
                    </span>
                    {item.kind === 'command' ? (
                      <>
                        <span className="min-w-0 flex-1 truncate">{item.command.label}</span>
                        {item.command.shortcut ? (
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-text-3">{item.command.shortcut}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate font-semibold">{item.page.title || 'Untitled'}</span>
                          <span className="shrink-0 font-mono text-[11px] text-text-3">{relativeTime(item.page.updatedAt)}</span>
                        </span>
                        {item.matches[0] ? (
                          <span className="flex min-w-0 gap-1.5 text-label text-text-2">
                            <MatchLabel match={item.matches[0]} />
                            <span className="min-w-0 truncate">
                              <Highlight parts={item.matches[0].parts} />
                            </span>
                          </span>
                        ) : item.page.preview ? (
                          <span className="truncate text-label text-text-3">{item.page.preview}</span>
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {empty ? (
                <div className="grid justify-items-center gap-2 px-5 py-7 text-center text-text-2">
                  <span className="grid size-11 place-items-center rounded-[12px] border-(length:--border-width) border-border bg-muted">
                    <SearchIcon size={20} />
                  </span>
                  <b className="text-[15px] text-foreground">Nothing matches</b>
                  <span>
                    Nothing matches “{needle}”
                    {scope === 'all' ? '' : ` in ${scope === 'notes' ? 'notes' : 'transcripts'}`}.
                  </span>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <ScrollArea as="aside" className="palette-preview min-h-0 p-3.5" aria-label="Preview">
            {active?.kind === 'session' ? (
              <div className="grid gap-2">
                <h3 className="m-0 text-title-2 font-semibold">{active.page.title || 'Untitled'}</h3>
                <p className="m-0 flex items-center gap-1.5 text-label text-text-3">
                  {active.page.speakers > 1 ? <PeopleIcon /> : null}
                  {sessionMeta(active.page)}
                </p>
                {active.page.tags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {active.page.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex h-5 items-center rounded-full border-(length:--border-width) border-border bg-muted px-2 text-label text-text-2 before:text-text-3 before:content-['#']"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {active.matches.length ? (
                  <ul className="m-0 grid list-none gap-1 p-0">
                    {active.matches.map((match, index) => (
                      <li key={index}>
                        <button
                          type="button"
                          tabIndex={-1}
                          className="grid w-full gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                          onClick={() => choose(active, match.line)}
                        >
                          <MatchLabel match={match} />
                          <span className="text-body-sm text-foreground">
                            <Highlight parts={match.parts} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 font-serif text-[15px] leading-6 text-text-2">{active.page.preview || 'No text yet.'}</p>
                )}
              </div>
            ) : active?.kind === 'command' ? (
              <div className="grid justify-items-start gap-2">
                <span className="grid size-9 place-items-center rounded-lg bg-muted">{active.command.icon ?? <CommandIcon />}</span>
                <h3 className="m-0 text-title-2 font-semibold">{active.command.label}</h3>
                {active.command.shortcut ? <span className="font-mono text-label text-text-3">{active.command.shortcut}</span> : null}
              </div>
            ) : null}
          </ScrollArea>
        </div>
        <footer className="flex gap-3.5 border-t border-border px-3 py-2 text-[11.5px] text-text-3">
          <span>
            <kbd className={kbd}>↑</kbd>
            <kbd className={kbd}>↓</kbd> move
          </span>
          <span>
            <kbd className={kbd}>↵</kbd> open
          </span>
          <span>
            <kbd className={kbd}>Tab</kbd> scope
          </span>
          <span className="ml-auto">
            <kbd className={kbd}>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  )
}

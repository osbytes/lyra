import { useMemo, useState } from 'react'
import type { PageSummary, UpdateStatus } from '../../../shared/types'
import lyraIcon from '../assets/lyra-icon.png'
import { dayGroup, shortcutLabel } from '../lib/format'
import { useContextMenu } from './ContextMenu'
import { ScrollArea } from './Controls'
import { FolderIcon, GearIcon, PeopleIcon, PlusIcon, SearchIcon, TrashIcon } from './Icons'
import { tip } from './Tooltip'

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  update: UpdateStatus
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (page: PageSummary) => void
  onSettings: () => void
  /** A setting needs attention (e.g. the shortcut is taken): flags the Settings button. */
  settingsIssue: boolean
  /** Opens the full-text search palette. */
  onSearch: () => void
  /** Every tag in use, with counts, most used first. */
  tags: readonly (readonly [string, number])[]
  tagFilter: string | null
  onTagFilter: (tag: string | null) => void
}

function updateLabel(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'available':
      return `Update to ${status.version}`
    case 'downloading':
      return status.percent > 0 ? `Downloading… ${status.percent}%` : 'Downloading…'
    case 'ready':
      return 'Restart to update'
    case 'error':
      return 'Update failed. Retry'
    case 'idle':
      return null
  }
}

type Group = { label: string; pages: PageSummary[] }

/** Pages arrive newest first, so consecutive pages share a heading. */
function groupByDay(pages: PageSummary[]): Group[] {
  const now = new Date()
  const groups: Group[] = []
  for (const page of pages) {
    const label = dayGroup(page.updatedAt, now)
    const last = groups.at(-1)
    if (last?.label === label) last.pages.push(page)
    else groups.push({ label, pages: [page] })
  }
  return groups
}

export function Sidebar({
  pages,
  activeId,
  update,
  onOpen,
  onCreate,
  onDelete,
  onSettings,
  settingsIssue,
  onSearch,
  tags,
  tagFilter,
  onTagFilter
}: Props) {
  const [query, setQuery] = useState('')
  const menu = useContextMenu()

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = pages.filter(
      (page) =>
        (!needle || `${page.title} ${page.preview} ${page.tags.join(' ')}`.toLowerCase().includes(needle)) &&
        (!tagFilter || page.tags.includes(tagFilter))
    )
    return groupByDay(visible)
  }, [pages, query, tagFilter])

  const label = updateLabel(update)
  const onUpdate = (): void => {
    if (update.state === 'ready') void window.api.installUpdate()
    else if (update.state !== 'downloading') void window.api.startUpdate()
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header drag">
        <div className="brand">
          <img src={lyraIcon} alt="" width={24} height={24} />
          <span>Lyra</span>
        </div>
      </div>

      <div className="sidebar-tools">
        <label className="search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="Search"
            aria-label="Search sessions"
          />
          {query ? null : (
            <button
              className="search-shortcut"
              type="button"
              onClick={onSearch}
              {...tip('Search notes and transcripts', shortcutLabel('K'))}
              aria-label={`Search notes and transcripts (${shortcutLabel('K')})`}
            >
              <kbd>{shortcutLabel('K')}</kbd>
            </button>
          )}
        </label>
        <button
          className="new-page-btn"
          type="button"
          onClick={onCreate}
          {...tip('New session', shortcutLabel('N'))}
          aria-label="New session"
        >
          <PlusIcon />
        </button>
      </div>

      {tags.length ? (
        <div className="tag-filters">
          <ScrollArea axis="x" className="tag-filters-scroll" role="group" aria-label="Filter by tag">
            <button
              type="button"
              className="filter-chip"
              aria-pressed={tagFilter === null}
              onClick={() => onTagFilter(null)}
            >
              All
            </button>
            {tags.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                className="filter-chip"
                aria-pressed={tagFilter === tag}
                onClick={() => onTagFilter(tagFilter === tag ? null : tag)}
              >
                #{tag}
                <span className="filter-count">{count}</span>
              </button>
            ))}
          </ScrollArea>
        </div>
      ) : null}

      <ScrollArea as="nav" className="page-list" aria-label="Sessions">
        {groups.length === 0 ? (
          tagFilter && !query ? (
            <div className="page-list-empty">
              <p>No sessions tagged #{tagFilter}.</p>
              <button className="btn" type="button" onClick={() => onTagFilter(null)}>
                Show all sessions
              </button>
            </div>
          ) : query ? (
            <div className="page-list-empty">
              <p>No sessions match “{query.trim()}”.</p>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setQuery('')
                }}
              >
                Clear search
              </button>
            </div>
          ) : (
            <p className="page-list-empty">Your sessions will appear here.</p>
          )
        ) : (
          groups.map((group) => (
            <section key={group.label} className="page-group" aria-label={group.label}>
              <h2 className="page-group-label">{group.label}</h2>
              {group.pages.map((page) => (
                <div
                  key={page.id}
                  className={`page-row${page.id === activeId ? ' active' : ''}`}
                  onContextMenu={(event) => {
                    menu.open(event, page.title || 'Untitled', [
                      { label: 'Open', run: () => onOpen(page.id) },
                      {
                        label: 'Show in folder',
                        icon: <FolderIcon />,
                        run: () => void window.api.revealPage(page.id)
                      },
                      'separator',
                      {
                        label: 'Delete…',
                        icon: <TrashIcon />,
                        shortcut: 'Del',
                        danger: true,
                        run: () => onDelete(page)
                      }
                    ])
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) {
                      event.preventDefault()
                      onDelete(page)
                    }
                  }}
                >
                  <button
                    type="button"
                    className="page-item"
                    aria-current={page.id === activeId ? 'page' : undefined}
                    onClick={() => {
                      onOpen(page.id)
                    }}
                  >
                    <span className="page-title">{page.title || 'Untitled'}</span>
                    <span className="page-preview">
                      {page.speakers > 1 ? (
                        <span className="page-speakers">
                          <PeopleIcon />
                          {page.speakers} speakers
                        </span>
                      ) : null}
                      {page.speakers > 1 ? ' · ' : null}
                      {page.preview || 'Empty session'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="page-delete"
                    aria-label={`Delete ${page.title || 'Untitled'}`}
                    {...tip('Delete session')}
                    onClick={() => {
                      onDelete(page)
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </section>
          ))
        )}
      </ScrollArea>

      <div className="sidebar-footer">
        <button
          className="ghost-btn"
          type="button"
          onClick={onSettings}
          aria-label={settingsIssue ? 'Settings (needs attention)' : 'Settings'}
          {...tip(settingsIssue ? 'A setting needs attention' : 'Settings', shortcutLabel(','))}
        >
          <span className="icon-with-badge">
            <GearIcon />
            {settingsIssue ? <span className="issue-dot" aria-hidden="true" /> : null}
          </span>
          Settings
        </button>
        {label ? (
          <button
            className="update-chip"
            type="button"
            disabled={update.state === 'downloading'}
            onClick={onUpdate}
            {...tip(label)}
          >
            <span className="update-dot" />
            <span className="update-label">{label}</span>
          </button>
        ) : null}
      </div>
      {menu.element}
    </aside>
  )
}

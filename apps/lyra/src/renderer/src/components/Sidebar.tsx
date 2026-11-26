import { memo, useMemo, useState } from 'react'
import type { MeetingStatus, PageSummary } from '../../../shared/types'
import { useActivity } from '../hooks/useActivity'
import { useMeetingStatuses } from '../hooks/useMeetingStatus'
import { dayGroup, keyLabel, shortcutLabel } from '../lib/format'
import { processingActivity, statusBusy } from '../lib/status'
import { ActivityFooter } from './Activity'
import { useContextMenu } from './ContextMenu'
import { ScrollArea } from './Controls'
import { CheckIcon, FolderIcon, GearIcon, PeopleIcon, PlusIcon, SearchIcon, SortIcon, TrashIcon } from './Icons'
import { tip } from './Tooltip'

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  /** The session being recorded, marked in the list (and pinned on top when it's further down). */
  recordingId: string | null
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (page: PageSummary) => void
  onSettings: () => void
  /** A setting needs attention (e.g. the shortcut is taken): flags the Settings button. */
  settingsIssue: boolean
  /** Opens the search palette (fuzzy titles, plus the notes and transcripts). */
  onSearch: () => void
  /** Every tag in use, with counts, most used first. */
  tags: readonly (readonly [string, number])[]
  tagFilter: string | null
  onTagFilter: (tag: string | null) => void
}

type Group = { label: string; pages: PageSummary[] }

/** Which date orders and groups the list: when a session started, or when it last changed. */
type SortBy = 'created' | 'updated'

const SORT_KEY = 'lyra.sessionSort'
const SORT_LABEL: Record<SortBy, string> = { created: 'Date created', updated: 'Last updated' }

function readSort(): SortBy {
  try {
    return localStorage.getItem(SORT_KEY) === 'updated' ? 'updated' : 'created'
  } catch {
    return 'created'
  }
}

function dateOf(page: PageSummary, sort: SortBy): string {
  return sort === 'created' ? page.startedAt : page.updatedAt
}

/** Newest first by the chosen date, so consecutive pages share a heading. */
function groupByDay(pages: PageSummary[], sort: SortBy): Group[] {
  const now = new Date()
  const groups: Group[] = []
  const sorted = pages.toSorted((a, b) => dateOf(b, sort).localeCompare(dateOf(a, sort)))
  for (const page of sorted) {
    const label = dayGroup(dateOf(page, sort), now)
    const last = groups.at(-1)
    if (last?.label === label) last.pages.push(page)
    else groups.push({ label, pages: [page] })
  }
  return groups
}

/** Memoized: the notes re-render the window on every keystroke, and the list hasn't changed. */
/** A spinner on a session still being processed after recording (speakers, summary). */
function ProcessingMark({ status, failed }: { status: MeetingStatus | undefined; failed: string | null }) {
  // A failure outlasts the status line, which clears; Activity keeps it until it's dealt with.
  if (failed && (!status || !statusBusy(status))) {
    return <span className="page-failed" role="img" aria-label={failed} {...tip(failed)} />
  }
  if (!status || !statusBusy(status)) return null
  const label = processingActivity(status, Date.now()).text
  return <span className="page-processing" role="img" aria-label={label} {...tip(label)} />
}

export const Sidebar = memo(function Sidebar({
  pages,
  activeId,
  recordingId,
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
  const menu = useContextMenu()
  const statuses = useMeetingStatuses()
  const { visible } = useActivity()
  const titles = useMemo(() => new Map(pages.map((page) => [page.id, page.title || 'Untitled'])), [pages])
  const failures = useMemo(() => {
    const byPage = new Map<string, string>()
    for (const item of visible) {
      if (item.pageId && (item.state === 'failed' || item.state === 'partial')) byPage.set(item.pageId, item.title)
    }
    return byPage
  }, [visible])

  const [sort, setSort] = useState(readSort)
  const chooseSort = (next: SortBy): void => {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // Storage can be unavailable; the order still applies until the window closes.
    }
  }
  const groups = useMemo(
    () => groupByDay(pages.filter((page) => !tagFilter || page.tags.includes(tagFilter)), sort),
    [pages, tagFilter, sort]
  )
  // A recording that isn't in the first group (an older session continued, or one filtered out)
  // is pinned above the list, so it's always in view.
  const recording = recordingId ? pages.find((page) => page.id === recordingId) : undefined
  const pinned = recording && !groups[0]?.pages.some((page) => page.id === recording.id) ? recording : undefined

  const row = (page: PageSummary): React.JSX.Element => (
    <div
      key={page.id}
      className={`page-row${page.id === activeId ? ' active' : ''}${page.id === recordingId ? ' is-recording' : ''}`}
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
            shortcut: keyLabel('Delete'),
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
        <span className="page-title">
          {page.id === recordingId ? (
            <span className="rec-dot" role="img" aria-label="Recording" {...tip('Recording')} />
          ) : (
            <ProcessingMark status={statuses.get(page.id)} failed={failures.get(page.id) ?? null} />
          )}
          {page.title || 'Untitled'}
        </span>
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
  )

  return (
    <aside className="sidebar">
      {/* The sidebar's share of the window's top band; the brand sits in the workspace's band. */}
      <div className="sidebar-tools drag">
        <button
          className="search no-drag"
          type="button"
          onClick={onSearch}
          aria-label={`Search sessions (${shortcutLabel('K')})`}
          {...tip('Search titles, notes and transcripts', shortcutLabel('K'))}
        >
          <SearchIcon />
          <span className="search-placeholder">Search</span>
          <kbd className="search-kbd">{shortcutLabel('K')}</kbd>
        </button>
        <button
          className="new-page-btn no-drag"
          type="button"
          aria-label={`Sort sessions: ${SORT_LABEL[sort]}`}
          aria-haspopup="menu"
          {...tip(`Sorted by ${SORT_LABEL[sort].toLowerCase()}`)}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            menu.openAt({
              x: rect.left,
              y: rect.bottom + 4,
              label: 'Sort sessions',
              items: (['created', 'updated'] as const).map((by) => ({
                label: SORT_LABEL[by],
                icon: by === sort ? <CheckIcon /> : <span aria-hidden="true" />,
                run: () => chooseSort(by)
              }))
            })
          }}
        >
          <SortIcon />
        </button>
        <button
          className="new-page-btn no-drag"
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

      {pinned ? (
        <section className="page-pinned" aria-label="Recording now">
          <h2 className="page-group-label">Recording now</h2>
          {row(pinned)}
        </section>
      ) : null}

      <ScrollArea as="nav" className="page-list" aria-label="Sessions">
        {groups.length === 0 ? (
          tagFilter ? (
            <div className="page-list-empty">
              <p>No sessions tagged #{tagFilter}.</p>
              <button className="btn" type="button" onClick={() => onTagFilter(null)}>
                Show all sessions
              </button>
            </div>
          ) : (
            <p className="page-list-empty">Your sessions will appear here.</p>
          )
        ) : (
          groups.map((group) => (
            <section key={group.label} className="page-group" aria-label={group.label}>
              <h2 className="page-group-label">{group.label}</h2>
              {group.pages.map(row)}
            </section>
          ))
        )}
      </ScrollArea>

      <ActivityFooter visible={visible} pageTitle={(id) => titles.get(id) ?? null} onOpen={onOpen} />
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
      </div>
      {menu.element}
    </aside>
  )
})

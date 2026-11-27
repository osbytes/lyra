import { memo, useMemo, useState } from 'react'
import type { MeetingStatus, PageSummary } from '../../../shared/types'
import { useActivity } from '../hooks/useActivity'
import { useMeetingStatuses } from '../hooks/useMeetingStatus'
import { useDensity } from '../lib/density'
import { clockLabel, dayGroup, keyLabel, shortcutLabel } from '../lib/format'
import { processingActivity, statusBusy } from '../lib/status'
import { cn } from '../lib/utils'
import { rowTime } from '../lib/when'
import { useContextMenu } from './ContextMenu'
import { ScrollArea } from './Controls'
import { HomeLink } from './Home'
import { notify } from '../lib/toast'
import {
  CheckIcon,
  CopyIcon,
  EditIcon,
  NoteIcon,
  SummaryIcon,
  ErrorIcon,
  GearIcon,
  PlusIcon,
  ProcessingIcon,
  RevealIcon,
  SearchIcon,
  SortIcon,
  TrashIcon
} from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { Kbd, LiveDot } from './ui/status'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  /** The session being recorded, marked in the list (and pinned on top when it's further down). */
  recordingId: string | null
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (page: PageSummary) => void
  onSettings: () => void
  /** A setting needs attention (e.g. the shortcut is taken): flags the Preferences button. */
  settingsIssue: boolean
  /** Opens the search palette (fuzzy titles, plus the notes and transcripts). */
  onSearch: () => void
  /** Every tag in use, with counts, most used first. */
  tags: readonly (readonly [string, number])[]
  tagFilter: string | null
  onTagFilter: (tag: string | null) => void
  /** Back to the Home dashboard; active while no session is open. */
  onHome: () => void
  homeActive: boolean
  /** Opens a session with its title selected, to rename it. */
  onRename: (id: string) => void
  /** Summaries are on, so a meeting's menu can write one. */
  canSummarize: boolean
}

type Group = { label: string; pages: PageSummary[] }

/** Which date orders and groups the list: when a session started, or when it last changed. */
type SortBy = 'created' | 'updated'

/** What the library shows: everything, meetings only, or the sessions that need the person. */
type Kind = 'all' | 'meetings' | 'attention'

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

/**
 * The marks slot at a row's right edge, always in the same order so the eye learns positions:
 * processing, then failed. Each mark is a shape (open arc, octagon), never a colour alone.
 */
function Marks({ status, failed }: { status: MeetingStatus | undefined; failed: string | null }) {
  const busy = status !== undefined && statusBusy(status)
  const label = busy ? processingActivity(status, Date.now()).text : null
  if (!label && !failed) return null
  return (
    <span className="inline-flex gap-[3px]">
      {label ? (
        <span role="img" aria-label={label} className="text-text-2" {...tip(label)}>
          <ProcessingIcon size={14} />
        </span>
      ) : null}
      {failed && !busy ? (
        <span role="img" aria-label={failed} className="text-destructive" {...tip(failed)}>
          <ErrorIcon size={14} />
        </span>
      ) : null}
    </span>
  )
}

function GroupHeading({ label }: { label: string }) {
  return (
    <h2 className="sticky top-0 z-[1] m-0 bg-muted px-3 py-1 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">
      {label}
    </h2>
  )
}

/** What a row says under its preview: how it was captured and who was in it. */
function kindLabel(page: PageSummary, live: boolean): string {
  const speakers = page.speakers > 1 ? `${String(page.speakers)} speakers` : null
  if (live) return speakers ? `Recording · ${speakers}` : 'Recording'
  if (speakers) return speakers
  return page.seconds !== null ? 'Dictation' : 'No recording'
}

/** Memoized: the notes re-render the window on every keystroke, and the list hasn't changed. */
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
  onTagFilter,
  onHome,
  homeActive,
  onRename,
  canSummarize
}: Props) {
  const menu = useContextMenu()
  const statuses = useMeetingStatuses()
  const { visible } = useActivity()
  const density = useDensity()
  const failures = useMemo(() => {
    const byPage = new Map<string, string>()
    for (const item of visible) {
      if (item.pageId && (item.state === 'failed' || item.state === 'partial')) byPage.set(item.pageId, item.title)
    }
    return byPage
  }, [visible])
  // Sessions that need the person: a failure Activity still holds, or results still changing.
  const attention = useMemo(() => {
    const ids = new Set(failures.keys())
    for (const [id, status] of statuses) if (statusBusy(status)) ids.add(id)
    return ids
  }, [failures, statuses])

  const [sort, setSort] = useState(readSort)
  const [kind, setKind] = useState<Kind>('all')
  const chooseSort = (next: SortBy): void => {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // Storage can be unavailable; the order still applies until the window closes.
    }
  }
  const groups = useMemo(
    () =>
      groupByDay(
        pages.filter(
          (page) =>
            (!tagFilter || page.tags.includes(tagFilter)) &&
            (kind === 'all' || (kind === 'meetings' ? page.speakers > 1 : attention.has(page.id)))
        ),
        sort
      ),
    [pages, tagFilter, sort, kind, attention]
  )
  // A recording that isn't in the first group (an older session continued, or one filtered out)
  // is pinned above the list, so it's always in view.
  const recording = recordingId ? pages.find((page) => page.id === recordingId) : undefined
  const pinned = recording && !groups[0]?.pages.some((page) => page.id === recording.id) ? recording : undefined

  const row = (page: PageSummary): React.JSX.Element => {
    const active = page.id === activeId
    const live = page.id === recordingId
    const title = page.title || 'Untitled'
    const shown = page.tags.slice(0, 3)
    return (
      <div
        key={page.id}
        className={cn(
          'page-row group relative border-b border-border',
          active &&
            'bg-brand-soft before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-[3px] before:bg-primary',
          live && 'bg-record-soft',
          !active && !live && 'hover:bg-accent'
        )}
        onContextMenu={(event) => {
          menu.open(event, title, [
            { label: 'Open', icon: <NoteIcon />, run: () => onOpen(page.id) },
            { label: 'Rename…', icon: <EditIcon />, run: () => onRename(page.id) },
            'separator',
            {
              label: 'Copy as Markdown',
              icon: <CopyIcon />,
              run: () => {
                window.api.getPage(page.id).then(
                  (full) => {
                    window.api.copyText(`# ${title}\n\n${full.body}`)
                    notify(`Copied “${title}”`)
                  },
                  () => notify('Couldn’t copy that session.')
                )
              }
            },
            {
              label: 'Copy title',
              icon: <CopyIcon />,
              run: () => {
                window.api.copyText(title)
                notify('Copied the title')
              }
            },
            ...(canSummarize && page.speakers > 1
              ? [
                  {
                    label: 'Write summary',
                    icon: <SummaryIcon />,
                    run: () => {
                      window.api.generateNotes(page.id).catch(() => {
                        // Shown in the work rail and Activity.
                      })
                      notify(`Writing a summary of “${title}”`)
                    }
                  }
                ]
              : []),
            { label: 'Show in folder', icon: <RevealIcon />, run: () => void window.api.revealPage(page.id) },
            'separator',
            {
              label: 'Delete session…',
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
          className={cn(
            'page-item grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 px-3 text-left',
            density === 'compact' ? 'py-[5px]' : 'py-[9px]',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
          )}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            onOpen(page.id)
          }}
        >
          <span className="page-title flex min-w-0 items-center gap-1.5 text-body-sm font-semibold text-foreground">
            {live ? <LiveDot role="img" aria-label="Recording" /> : null}
            <span className={cn('truncate', !page.title && 'font-medium text-text-2')}>{title}</span>
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11.5px] whitespace-nowrap text-text-3">
            {live ? null : <Marks status={statuses.get(page.id)} failed={failures.get(page.id) ?? null} />}
            {live ? 'REC' : rowTime(dateOf(page, sort))}
          </span>
          {density === 'compact' ? null : (
            <span className={cn('page-preview col-span-2 truncate text-label text-text-3', !page.preview && 'italic')}>
              {page.preview || 'Empty'}
            </span>
          )}
          {/* Keeps room at its end for the delete button, so it appears without moving anything. */}
          <span className="col-span-2 flex min-w-0 items-center gap-2 overflow-hidden pr-7 font-mono text-[11.5px] whitespace-nowrap text-text-3">
            {page.seconds !== null ? <span>{clockLabel(page.seconds)}</span> : null}
            <span className="font-sans">{kindLabel(page, live)}</span>
            {shown.map((tag) => (
              <span
                key={tag}
                className="inline-flex h-[18px] items-center rounded-full border-(length:--border-width) border-border bg-muted px-1.5 font-sans text-[11px] text-text-2 before:text-text-3 before:content-['#']"
              >
                {tag}
              </span>
            ))}
            {page.tags.length > shown.length ? (
              <span className="font-sans">+{page.tags.length - shown.length}</span>
            ) : null}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="page-delete absolute right-2 bottom-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          aria-label={`Delete ${title}`}
          {...tip('Delete session')}
          onClick={() => {
            onDelete(page)
          }}
        >
          <TrashIcon />
        </Button>
      </div>
    )
  }

  const filtered = tagFilter !== null || kind !== 'all'

  return (
    <aside className="sidebar">
      {/* The sidebar's share of the window's top band; the brand sits in the workspace's band. */}
      <div className="sidebar-tools drag">
        <button
          className={cn(
            'search no-drag flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2.5 text-left text-body',
            'border-(length:--border-width) border-input bg-card text-text-3 hover:bg-accent',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring'
          )}
          type="button"
          onClick={onSearch}
          aria-label={`Search everything (${shortcutLabel('K')})`}
          {...tip('Search titles, notes and transcripts', shortcutLabel('K'))}
        >
          <SearchIcon />
          <span className="min-w-0 flex-1 truncate">Search</span>
          <Kbd>{shortcutLabel('K')}</Kbd>
        </button>
        <Button
          size="icon"
          className="no-drag"
          onClick={onCreate}
          {...tip('New session', shortcutLabel('N'))}
          aria-label="New session"
        >
          <PlusIcon />
        </Button>
      </div>

      <HomeLink active={homeActive} onClick={onHome} />
      <div className="flex flex-col gap-2 px-2.5 pt-2 pb-2">
        <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          role="radiogroup"
          aria-label="Show"
          value={kind}
          onValueChange={(next) => {
            if (next === 'all' || next === 'meetings' || next === 'attention') setKind(next)
          }}
        >
          <ToggleGroupItem value="all" role="radio" aria-checked={kind === 'all'}>
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="meetings" role="radio" aria-checked={kind === 'meetings'}>
            Meetings
          </ToggleGroupItem>
          <ToggleGroupItem value="attention" role="radio" aria-checked={kind === 'attention'}>
            Needs you{attention.size ? ` · ${String(attention.size)}` : ''}
          </ToggleGroupItem>
        </ToggleGroup>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
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
          </Button>
        </div>
        {tags.length ? (
          <ScrollArea axis="x" className="tag-filters-scroll flex gap-1" role="group" aria-label="Filter by tag">
            {tags.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                aria-pressed={tagFilter === tag}
                className={cn(
                  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border-(length:--border-width) border-border bg-muted px-2 text-label whitespace-nowrap text-text-2',
                  "before:text-text-3 before:content-['#'] hover:text-foreground",
                  'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:before:text-primary-foreground',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring'
                )}
                onClick={() => onTagFilter(tagFilter === tag ? null : tag)}
              >
                {tag}
                <span className="font-mono text-[10.5px] opacity-75">{count}</span>
              </button>
            ))}
          </ScrollArea>
        ) : null}
      </div>

      {pinned ? (
        <section className="page-pinned border-t border-border" aria-label="Recording now">
          <GroupHeading label="Now" />
          {row(pinned)}
        </section>
      ) : null}

      <ScrollArea as="nav" className="page-list border-t border-border" aria-label="Sessions">
        {groups.length === 0 ? (
          <div className="grid justify-items-center gap-2 px-5 py-7 text-center text-body-sm text-text-2">
            {filtered ? (
              <>
                <b className="text-body text-foreground">No sessions match</b>
                <span>
                  {kind === 'attention'
                    ? 'Nothing needs you right now.'
                    : tagFilter
                      ? `Nothing ${kind === 'meetings' ? 'from a meeting ' : ''}tagged #${tagFilter}.`
                      : 'No meetings yet.'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onTagFilter(null)
                    setKind('all')
                  }}
                >
                  Clear all filters
                </Button>
              </>
            ) : (
              <span>Your sessions will appear here.</span>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="page-group" aria-label={group.label}>
              <GroupHeading label={group.label} />
              {group.pages.map(row)}
            </section>
          ))
        )}
      </ScrollArea>

      <div className="sidebar-footer flex items-center border-t border-border p-2">
        <Button
          variant="ghost"
          onClick={onSettings}
          aria-label={settingsIssue ? 'Preferences (needs attention)' : 'Preferences'}
          {...tip(settingsIssue ? 'A setting needs attention' : 'Preferences', shortcutLabel(','))}
        >
          <span className="relative inline-grid">
            <GearIcon />
            {settingsIssue ? (
              // Attention is a triangle badge, never a colour alone.
              <span
                aria-hidden="true"
                className="absolute -right-1 -bottom-1 size-2 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]"
              />
            ) : null}
          </span>
          Preferences
        </Button>
      </div>
      {menu.element}
    </aside>
  )
})

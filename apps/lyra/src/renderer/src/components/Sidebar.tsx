import { useMemo, useState } from 'react'
import type { PageSummary, UpdateStatus } from '../../../shared/types'
import lyraIcon from '../assets/lyra-icon.png'
import { dayGroup, shortcutLabel } from '../lib/format'
import { GearIcon, PlusIcon, SearchIcon, TrashIcon } from './Icons'

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  update: UpdateStatus
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (page: PageSummary) => void
  onSettings: () => void
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
      return 'Update failed — retry'
    default:
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
  onSettings
}: Props) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = needle
      ? pages.filter((page) => `${page.title} ${page.preview}`.toLowerCase().includes(needle))
      : pages
    return groupByDay(visible)
  }, [pages, query])

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
            placeholder="Search pages"
            aria-label="Search pages"
          />
        </label>
        <button
          className="new-page-btn"
          type="button"
          onClick={onCreate}
          title={`New page (${shortcutLabel('N')})`}
          aria-label="New page"
        >
          <PlusIcon />
        </button>
      </div>

      <nav className="page-list" aria-label="Pages">
        {groups.length === 0 ? (
          query ? (
            <div className="page-list-empty">
              <p>No pages match “{query.trim()}”.</p>
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
            <p className="page-list-empty">Your pages will appear here.</p>
          )
        ) : (
          groups.map((group) => (
            <section key={group.label} className="page-group" aria-label={group.label}>
              <h2 className="page-group-label">{group.label}</h2>
              {group.pages.map((page) => (
                <div key={page.id} className={`page-row${page.id === activeId ? ' active' : ''}`}>
                  <button
                    type="button"
                    className="page-item"
                    aria-current={page.id === activeId ? 'page' : undefined}
                    onClick={() => {
                      onOpen(page.id)
                    }}
                  >
                    <span className="page-title">{page.title || 'Untitled'}</span>
                    <span className="page-preview">{page.preview || 'Empty page'}</span>
                  </button>
                  <button
                    type="button"
                    className="page-delete"
                    aria-label={`Delete ${page.title || 'Untitled'}`}
                    title="Delete page"
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
      </nav>

      <div className="sidebar-footer">
        <button
          className="ghost-btn"
          type="button"
          onClick={onSettings}
          title={`Settings (${shortcutLabel(',')})`}
        >
          <GearIcon />
          Settings
        </button>
        {label ? (
          <button
            className="update-chip"
            type="button"
            disabled={update.state === 'downloading'}
            onClick={onUpdate}
            title={label}
          >
            <span className="update-dot" />
            <span className="update-label">{label}</span>
          </button>
        ) : null}
      </div>
    </aside>
  )
}

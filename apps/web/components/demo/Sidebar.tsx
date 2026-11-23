'use client'

// A port of apps/lyra/src/renderer/src/components/Sidebar.tsx (without the updater button).
import Image from 'next/image'
import { useMemo, useState } from 'react'
import { previewOf } from '@/lib/demo/preview'
import { byRecent } from '@/lib/demo/reducer'
import { presentSpeakers } from '@/lib/demo/speakers'
import { dayGroup } from '@/lib/demo/time'
import type { Session } from '@/lib/demo/types'
import { ScrollArea } from './Controls'
import { useDemo } from './DemoProvider'
import { GearIcon, PeopleIcon, PlusIcon, SearchIcon, TrashIcon } from './Icons'

type Props = {
  tags: readonly (readonly [string, number])[]
  onCreate: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onSettings: () => void
  newSessionTitle: string
}

type Group = { label: string; sessions: Session[] }

export function Sidebar({ tags, onCreate, onOpen, onDelete, onSettings, newSessionTitle }: Props) {
  const { state, exportContext, dispatch } = useDemo()
  const [query, setQuery] = useState('')
  const { tagFilter } = state

  const groups = useMemo((): Group[] => {
    const needle = query.trim().toLowerCase()
    const visible = [...state.sessions]
      .sort(byRecent)
      .filter(
        (session) =>
          (!needle ||
            `${session.title} ${previewOf(session, exportContext)} ${session.tags.join(' ')}`
              .toLowerCase()
              .includes(needle)) &&
          (!tagFilter || session.tags.includes(tagFilter))
      )
    const out: Group[] = []
    for (const session of visible) {
      const label = dayGroup(session.editedAt, state.now)
      const last = out.at(-1)
      if (last?.label === label) last.sessions.push(session)
      else out.push({ label, sessions: [session] })
    }
    return out
  }, [state.sessions, state.now, query, tagFilter, exportContext])

  const setFilter = (tag: string | null): void => {
    dispatch({ type: 'filter', tag })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <Image src="/lyra-icon.png" alt="" width={24} height={24} />
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
            placeholder="Search sessions"
            aria-label="Search sessions"
          />
        </label>
        <button className="new-page-btn" type="button" onClick={onCreate} title={newSessionTitle} aria-label="New session">
          <PlusIcon />
        </button>
      </div>

      {tags.length ? (
        <div className="tag-filters">
          <ScrollArea axis="x" className="tag-filters-scroll" role="group" aria-label="Filter by tag">
            <button type="button" className="filter-chip" aria-pressed={tagFilter === null} onClick={() => setFilter(null)}>
              All
            </button>
            {tags.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                className="filter-chip"
                aria-pressed={tagFilter === tag}
                onClick={() => setFilter(tagFilter === tag ? null : tag)}
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
              <button className="btn" type="button" onClick={() => setFilter(null)}>
                Show all sessions
              </button>
            </div>
          ) : query ? (
            <div className="page-list-empty">
              <p>No sessions match “{query.trim()}”.</p>
              <button className="btn" type="button" onClick={() => setQuery('')}>
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
              {group.sessions.map((session) => {
                const active = session.id === state.currentId
                const speakers = session.meeting ? presentSpeakers(state.speakers, state.lines).length : 0
                return (
                  <div key={session.id} className={`page-row${active ? ' active' : ''}`}>
                    <button
                      type="button"
                      className="page-item"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => {
                        onOpen(session.id)
                      }}
                    >
                      <span className="page-title">{session.title || 'Untitled'}</span>
                      <span className="page-preview">
                        {speakers > 1 ? (
                          <span className="page-speakers">
                            <PeopleIcon />
                            {speakers} speakers ·{' '}
                          </span>
                        ) : null}
                        {previewOf(session, exportContext) || 'Empty session'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="page-delete"
                      aria-label={`Delete ${session.title || 'Untitled'}`}
                      title="Delete session"
                      onClick={() => {
                        onDelete(session.id)
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )
              })}
            </section>
          ))
        )}
      </ScrollArea>

      <div className="sidebar-footer">
        <button className="ghost-btn" type="button" onClick={onSettings}>
          <GearIcon />
          Settings
        </button>
      </div>
    </aside>
  )
}

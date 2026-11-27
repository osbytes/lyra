import { useMemo, useState } from 'react'
import type { PageSummary } from '../../../shared/types'
import { useActivity } from '../hooks/useActivity'
import { useMeetingStatuses } from '../hooks/useMeetingStatus'
import { dailyRecording, durationLabel, greeting, topTags, weekStats } from '../lib/dashboard'
import { clockLabel, shortcutLabel } from '../lib/format'
import { processingActivity, statusBusy } from '../lib/status'
import { cn } from '../lib/utils'
import { rowTime } from '../lib/when'
import { ScrollArea } from './Controls'
import { ErrorIcon, HomeIcon, LocalIcon, NoteIcon, ProcessingIcon, RecordDotIcon, SearchIcon } from './Icons'
import { Button } from './ui/button'
import { Kbd, LiveDot } from './ui/status'

type Props = {
  pages: PageSummary[]
  recordingId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onSearch: () => void
}

const CHART_DAYS = 14

/** A KPI: its label, the number, and how it moved against the week before (neutral ink). */
export function Tile({ label, value, delta, hint }: { label: string; value: string; delta: string | null; hint?: string }) {
  return (
    <div className="grid min-w-0 content-start gap-1 rounded-lg border-(length:--border-width) border-border bg-card px-4 py-3.5">
      <span className="text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">{label}</span>
      <span className="font-mono text-[28px] leading-[34px] font-medium tracking-[-0.01em] tabular-nums">{value}</span>
      <span className="truncate text-label text-text-3">{delta ?? hint ?? ' '}</span>
    </div>
  )
}

function change(now: number, before: number, unit: (n: number) => string): string | null {
  if (now === before) return before ? 'Same as the week before' : null
  const diff = now - before
  return `${diff > 0 ? '↑' : '↓'} ${unit(Math.abs(diff))} vs the week before`
}

function kindOf(page: PageSummary): string {
  if (page.speakers > 1) return `${String(page.speakers)} speakers`
  return page.seconds !== null ? 'Dictation' : 'No recording'
}

/**
 * Home: where Lyra opens when no session is: what you've captured lately, at a glance. Last
 * week's numbers, recorded time per day, the sessions that need you, recent ones, and tags.
 */
export function Home({ pages, recordingId, onOpen, onNew, onSearch }: Props) {
  const statuses = useMeetingStatuses()
  const { visible } = useActivity()
  const now = useMemo(() => new Date(), [])
  const week = useMemo(() => weekStats(pages, now), [pages, now])
  const days = useMemo(() => dailyRecording(pages, CHART_DAYS, now), [pages, now])
  const tags = useMemo(() => topTags(pages, 6), [pages])
  const recent = useMemo(
    () => pages.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    [pages]
  )
  const needs = useMemo(() => {
    const out: { page: PageSummary; text: string; failed: boolean }[] = []
    for (const page of pages) {
      const failed = visible.find(
        (item) => item.pageId === page.id && (item.state === 'failed' || item.state === 'partial')
      )
      const status = statuses.get(page.id)
      if (failed) out.push({ page, text: failed.title, failed: true })
      else if (status && statusBusy(status)) out.push({ page, text: processingActivity(status, Date.now()).text, failed: false })
    }
    return out
  }, [pages, visible, statuses])
  const recording = recordingId ? pages.find((page) => page.id === recordingId) : undefined
  const longest = Math.max(60, ...days.map((day) => day.seconds))
  const [hover, setHover] = useState<number | null>(null)
  const total = days.reduce((sum, day) => sum + day.seconds, 0)

  const tiles: { label: string; value: string; delta: string | null; hint?: string }[] = [
    {
      label: 'Sessions this week',
      value: String(week.current.sessions),
      delta: change(week.current.sessions, week.previous.sessions, String)
    },
    {
      label: 'Recorded this week',
      value: durationLabel(week.current.seconds),
      delta: change(week.current.seconds, week.previous.seconds, durationLabel)
    },
    {
      label: 'Meetings',
      value: String(week.current.meetings),
      delta: null,
      hint: `${String(week.current.dictations)} ${week.current.dictations === 1 ? 'dictation' : 'dictations'} this week`
    },
    {
      label: 'Needs you',
      value: String(needs.length),
      delta: null,
      hint: needs.length ? 'Below' : 'All caught up'
    }
  ]

  return (
    <ScrollArea className="home scroller min-h-0 flex-1">
      <div className="mx-auto grid w-full max-w-[1040px] gap-7 px-8 pt-6 pb-16">
        <header className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <span className="font-mono text-label text-text-3">
              {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <h1 className="m-0 text-display font-semibold tracking-[-0.01em]">{greeting(now)}</h1>
          </div>
          <Button variant="ghost" onClick={onSearch}>
            <SearchIcon />
            Search
            <Kbd>{shortcutLabel('K')}</Kbd>
          </Button>
          <Button variant="primary" size="lg" onClick={onNew}>
            <RecordDotIcon />
            New session
          </Button>
        </header>

        {recording ? (
          <button
            type="button"
            className="flex items-center gap-3 rounded-lg border-(length:--border-width) border-record/40 bg-record-soft px-4 py-3 text-left hover:brightness-[0.98] focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onOpen(recording.id)}
          >
            <LiveDot />
            <span className="font-semibold text-record">Recording</span>
            <span className="min-w-0 flex-1 truncate">{recording.title || 'Untitled'}</span>
            <span className="text-label text-text-2">Open</span>
          </button>
        ) : null}

        <section className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3" aria-label="This week">
          {tiles.map((tile) => (
            <Tile key={tile.label} {...tile} />
          ))}
        </section>

        <section className="grid gap-3" aria-label={`Recorded time, last ${String(CHART_DAYS)} days`}>
          <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Recorded time</h2>
            <span className="text-label text-text-3">
              last {CHART_DAYS} days · {durationLabel(total)}
            </span>
          </div>
          <div className="relative grid gap-1.5">
            <span className="absolute top-0 left-0 font-mono text-[10.5px] text-text-3">{durationLabel(longest)}</span>
            {total === 0 ? (
              <span className="absolute inset-x-0 top-16 text-center text-body-sm text-text-3">
                Nothing recorded in the last {CHART_DAYS} days. Start a session and it shows up here.
              </span>
            ) : null}
            {/* One series, one hue; bars grow from the baseline with 4 px rounded tops. */}
            <div className="flex h-40 items-end gap-[2px] border-b border-border pt-5" role="img" aria-label={days.map((day) => `${day.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}: ${durationLabel(day.seconds)}`).join(', ')}>
              {days.map((day, index) => (
                <div
                  key={day.date.toISOString()}
                  className="group relative flex h-full flex-1 items-end"
                  onPointerEnter={() => setHover(index)}
                  onPointerLeave={() => setHover(null)}
                >
                  <div
                    className={cn(
                      'w-full rounded-t-[4px] transition-colors',
                      day.seconds ? (hover === index ? 'bg-primary-hover' : 'bg-primary') : 'bg-surface-3'
                    )}
                    style={{ height: day.seconds ? `${String(Math.max(4, (day.seconds / longest) * 100))}%` : '2px' }}
                  />
                  {hover === index ? (
                    <span className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 w-max -translate-x-1/2 rounded-sm border-(length:--border-width) border-border bg-popover px-2 py-1 text-label text-popover-foreground shadow-md">
                      <b className="font-semibold">
                        {day.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                      </b>
                      <span className="block text-text-2">
                        {day.seconds ? durationLabel(day.seconds) : 'Nothing recorded'}
                        {day.sessions ? ` · ${String(day.sessions)} ${day.sessions === 1 ? 'session' : 'sessions'}` : ''}
                      </span>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex gap-[2px]" aria-hidden="true">
              {days.map((day, index) => (
                <span key={day.date.toISOString()} className={cn('flex-1 text-center font-mono text-[10.5px] text-text-3', index === days.length - 1 && 'font-semibold text-foreground')}>
                  {index === days.length - 1 ? 'Today' : index % 2 === days.length % 2 ? day.date.toLocaleDateString(undefined, { weekday: 'narrow' }) : ''}
                </span>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-7 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <section className="grid content-start gap-2" aria-label="Recent sessions">
            <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Recent</h2>
            <ul className="m-0 grid list-none p-0">
              {recent.map((page) => (
                <li key={page.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-sm px-1.5 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => onOpen(page.id)}
                  >
                    <NoteIcon className="text-text-3" />
                    <span className="min-w-0">
                      <span className="block truncate text-body-sm font-semibold">{page.title || 'Untitled'}</span>
                      <span className="block truncate font-mono text-[11.5px] text-text-3">
                        {page.seconds !== null ? `${clockLabel(page.seconds)} · ` : ''}
                        <span className="font-sans">{kindOf(page)}</span>
                      </span>
                    </span>
                    <span className="font-mono text-[11.5px] text-text-3">{rowTime(page.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid content-start gap-7">
            <section className="grid content-start gap-2" aria-label="Needs you">
              <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Needs you</h2>
              {needs.length ? (
                <ul className="m-0 grid list-none p-0">
                  {needs.map(({ page, text, failed }) => (
                    <li key={page.id}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2.5 rounded-sm px-1.5 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onOpen(page.id)}
                      >
                        {failed ? (
                          <ErrorIcon className="mt-0.5 shrink-0 text-destructive" />
                        ) : (
                          <ProcessingIcon className="mt-0.5 shrink-0 text-text-2" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-body-sm font-semibold">{page.title || 'Untitled'}</span>
                          <span className={cn('block text-label', failed ? 'text-destructive' : 'text-text-3')}>{text}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-body-sm text-text-3">Nothing is waiting on you.</p>
              )}
            </section>

            {tags.length ? (
              <section className="grid content-start gap-2" aria-label="Tags">
                <h2 className="m-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">Tags</h2>
                <ul className="m-0 grid list-none gap-1.5 p-0">
                  {tags.map(([tag, count]) => (
                    <li key={tag} className="grid grid-cols-[minmax(72px,120px)_minmax(0,1fr)_32px] items-center gap-2.5 text-body-sm">
                      <span className="truncate text-text-2 before:text-text-3 before:content-['#']">{tag}</span>
                      <span className="h-2 rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${String((count / (tags[0]?.[1] ?? 1)) * 100)}%` }}
                        />
                      </span>
                      <span className="text-right font-mono text-[11.5px] text-text-3">{count}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p className="m-0 flex items-center gap-2 text-label text-text-3">
              <LocalIcon className="text-local" />
              {pages.length} {pages.length === 1 ? 'session' : 'sessions'}, all on this computer.
            </p>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

/** The Home entry at the top of the library. */
export function HomeLink({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        'home-link relative flex h-9 w-full items-center gap-2 border-y border-border px-3 text-body-sm font-semibold',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-brand-soft text-brand-text before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-[3px] before:bg-primary'
          : 'text-foreground hover:bg-accent'
      )}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <HomeIcon />
      Home
    </button>
  )
}

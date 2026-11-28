import { useMemo, useState, type ReactNode } from 'react'
import type { PageSummary, Person } from '../../../shared/types'
import { usePeopleActivity } from '../hooks/usePeopleActivity'
import { durationLabel } from '../lib/dashboard'
import { personDetail, personTotals, sortPeople, totalsOf, type PeopleSort, type PersonTotals } from '../lib/peopleStats'
import { speakerSlot } from '../lib/speakerTone'
import { cn } from '../lib/utils'
import { rowTime } from '../lib/when'
import { ScrollArea } from './Controls'
import { Tile } from './Home'
import { CheckIcon, ChevronRightIcon, ErrorIcon, NoteIcon, PeopleIcon } from './Icons'
import { SpeakerBadge } from './SpeakerBadge'
import { Button } from './ui/button'

const WEEKS = 12

const heading = 'm-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase'
const rowButton =
  'w-full rounded-sm text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring'

const percent = (share: number | null): string => (share === null ? '—' : `${String(Math.round(share * 100))}%`)
const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`
const dateLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** A share of the talking as a thin bar and a number; one hue, the number carries it. */
function ShareBar({ share }: { share: number | null }) {
  return (
    <span className="grid grid-cols-[minmax(0,1fr)_36px] items-center gap-2">
      <span className="h-1.5 rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${String((share ?? 0) * 100)}%` }} />
      </span>
      <span className="text-right font-mono text-[11.5px] text-text-2 tabular-nums">{percent(share)}</span>
    </span>
  )
}

/** The index couldn't be read: what didn't work and the way forward (docs/STATES.md). */
function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border-(length:--border-width) border-border bg-card px-4 py-3" role="alert">
      <ErrorIcon className="shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-body-sm">
        Couldn’t read who spoke in your sessions. The search index may still be starting.
      </span>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  )
}

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ScrollArea className="people-page scroller min-h-0 flex-1" aria-label={label}>
      <div className="mx-auto grid w-full max-w-[1040px] gap-7 px-8 pt-6 pb-16">{children}</div>
    </ScrollArea>
  )
}

const SORTS: { value: PeopleSort; label: string }[] = [
  { value: 'talk', label: 'Talk time' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'recent', label: 'Last heard' },
  { value: 'name', label: 'Name' }
]

type ListProps = {
  pages: PageSummary[]
  people: Person[]
  onOpenPerson: (id: string) => void
  onAddPeople: () => void
}

/** Home → People: everyone with a saved voice, how often they're heard and how much they say. */
export function PeopleOverview({ pages, people, onOpenPerson, onAddPeople }: ListProps) {
  const loaded = usePeopleActivity(pages, people)
  const [sort, setSort] = useState<PeopleSort>('talk')
  const activity = loaded.state === 'ready' ? loaded.activity : null
  const totals = useMemo(() => (activity ? personTotals(people, activity) : new Map<string, PersonTotals>()), [people, activity])
  const sorted = useMemo(() => sortPeople(people, totals, sort), [people, totals, sort])
  const talk = [...totals.values()].reduce((sum, t) => sum + t.talkSeconds, 0)
  const top = sortPeople(people, totals, 'talk')[0]
  const topTalk = top ? totalsOf(totals, top.id).talkSeconds : 0

  return (
    <Frame label="People">
      <header className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="font-mono text-label text-text-3">Home</span>
          <h1 className="m-0 text-display font-semibold tracking-[-0.01em]">People</h1>
        </div>
        <Button variant="ghost" onClick={onAddPeople}>
          Manage voices
        </Button>
      </header>

      {loaded.state === 'failed' ? <LoadError onRetry={loaded.retry} /> : null}

      {people.length === 0 ? (
        <div className="grid max-w-[480px] gap-3">
          <p className="m-0 text-body-sm text-text-2">
            No saved voices yet. Save someone’s voice and Lyra names them in meetings, then counts
            how often they’re heard and how much they say here.
          </p>
          <Button variant="primary" className="justify-self-start" onClick={onAddPeople}>
            Add a person
          </Button>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3" aria-label="Everyone">
            <Tile label="People" value={String(people.length)} delta={null} hint="With a saved voice" />
            <Tile
              label="Sessions"
              value={activity ? String(activity.sessions.length) : '—'}
              delta={null}
              hint="With someone saved in them"
            />
            <Tile label="Talk time" value={activity ? durationLabel(talk) : '—'} delta={null} hint="Everyone saved, together" />
            <Tile
              label="Heard most"
              value={top && topTalk > 0 ? top.name : '—'}
              delta={null}
              hint={top && topTalk > 0 ? durationLabel(topTalk) : 'Nobody heard yet'}
            />
          </section>

          <section className="grid gap-2" aria-label="Everyone with a saved voice">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn(heading, 'flex-1')}>Everyone</h2>
              <span className="text-label text-text-3" id="people-sort-label">
                Sort by
              </span>
              <div className="flex gap-1" role="radiogroup" aria-labelledby="people-sort-label">
                {SORTS.map((option) => (
                  <Button
                    key={option.value}
                    variant="ghost"
                    size="sm"
                    role="radio"
                    aria-checked={sort === option.value}
                    className={cn(sort === option.value && 'bg-accent text-foreground')}
                    onClick={() => setSort(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            <div
              className="grid grid-cols-[minmax(160px,1.6fr)_72px_88px_minmax(110px,1fr)_88px_16px] items-center gap-x-4 border-b border-border px-2 pb-1.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase"
              aria-hidden="true"
            >
              <span>Name</span>
              <span className="text-right">Sessions</span>
              <span className="text-right">Talk time</span>
              <span>Share of talk</span>
              <span className="text-right">Last heard</span>
              <span />
            </div>
            <ul className="m-0 grid list-none p-0">
              {sorted.map((person) => {
                const t = totalsOf(totals, person.id)
                return (
                  <li key={person.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      className={cn(
                        rowButton,
                        'grid grid-cols-[minmax(160px,1.6fr)_72px_88px_minmax(110px,1fr)_88px_16px] items-center gap-x-4 px-2 py-2.5'
                      )}
                      aria-label={`${person.name}: ${plural(t.sessions, 'session')}, ${durationLabel(t.talkSeconds)} talking`}
                      onClick={() => onOpenPerson(person.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <SpeakerBadge name={person.name} slot={speakerSlot(people, person.id)} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-body-sm font-semibold">{person.name}</span>
                            {person.self ? (
                              <span className="rounded-full bg-brand-soft px-1.5 text-[10.5px] font-semibold text-brand-text">You</span>
                            ) : null}
                          </span>
                          <span className="block truncate text-label text-text-3">
                            {t.words ? `${t.words.toLocaleString()} words` : 'Not heard yet'}
                            {t.openActions ? ` · ${plural(t.openActions, 'open action')}` : ''}
                          </span>
                        </span>
                      </span>
                      <span className="text-right font-mono text-body-sm tabular-nums">{activity ? t.sessions : '—'}</span>
                      <span className="text-right font-mono text-body-sm tabular-nums">
                        {activity ? durationLabel(t.talkSeconds) : '—'}
                      </span>
                      <ShareBar share={t.share} />
                      <span className="text-right font-mono text-[11.5px] text-text-3">
                        {t.lastSeen ? rowTime(t.lastSeen) : '—'}
                      </span>
                      <ChevronRightIcon className="text-text-3" />
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="m-0 text-label text-text-3">
              Counts speakers named as a saved person. Share of talk is their part of everything said in
              the sessions they were in.
            </p>
          </section>
        </>
      )}
    </Frame>
  )
}

type WeekChartProps = { weeks: { start: Date; seconds: number; sessions: number }[] }

/** Their talk time per week; one series, one hue, like Home's chart. */
function WeekChart({ weeks }: WeekChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const longest = Math.max(60, ...weeks.map((week) => week.seconds))
  const weekLabel = (date: Date): string => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return (
    <div className="relative grid gap-1.5">
      <span className="absolute top-0 left-0 font-mono text-[10.5px] text-text-3">{durationLabel(longest)}</span>
      <div
        className="flex h-32 items-end gap-1 border-b border-border pt-5"
        role="img"
        aria-label={weeks.map((week) => `Week of ${weekLabel(week.start)}: ${durationLabel(week.seconds)}`).join(', ')}
      >
        {weeks.map((week, index) => (
          <div
            key={week.start.toISOString()}
            className="relative flex h-full flex-1 items-end"
            onPointerEnter={() => setHover(index)}
            onPointerLeave={() => setHover(null)}
          >
            <div
              className={cn(
                'w-full rounded-t-[4px] transition-colors',
                week.seconds ? (hover === index ? 'bg-primary-hover' : 'bg-primary') : 'bg-surface-3'
              )}
              style={{ height: week.seconds ? `${String(Math.max(4, (week.seconds / longest) * 100))}%` : '2px' }}
            />
            {hover === index ? (
              <span className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 w-max -translate-x-1/2 rounded-sm border-(length:--border-width) border-border bg-popover px-2 py-1 text-label text-popover-foreground shadow-md">
                <b className="font-semibold">Week of {weekLabel(week.start)}</b>
                <span className="block text-text-2">
                  {week.seconds ? durationLabel(week.seconds) : 'Not heard'}
                  {week.sessions ? ` · ${plural(week.sessions, 'session')}` : ''}
                </span>
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {weeks.map((week, index) => (
          <span
            key={week.start.toISOString()}
            className={cn('flex-1 text-center font-mono text-[10.5px] text-text-3', index === weeks.length - 1 && 'font-semibold text-foreground')}
          >
            {index === weeks.length - 1 ? 'This week' : index % 3 === (weeks.length - 1) % 3 ? weekLabel(week.start) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

type PersonProps = {
  personId: string
  pages: PageSummary[]
  people: Person[]
  onBack: () => void
  onOpenPerson: (id: string) => void
  onOpenSession: (id: string) => void
}

/** One person: how much they're heard, week by week, in which sessions and with whom. */
export function PersonPage({ personId, pages, people, onBack, onOpenPerson, onOpenSession }: PersonProps) {
  const loaded = usePeopleActivity(pages, people)
  const person = people.find((entry) => entry.id === personId)
  const activity = loaded.state === 'ready' ? loaded.activity : null
  const now = useMemo(() => new Date(), [])
  const totals = useMemo(
    () => (activity && person ? totalsOf(personTotals([person], activity), person.id) : null),
    [activity, person]
  )
  const detail = useMemo(
    () => (activity && person ? personDetail(person, activity, WEEKS, now) : null),
    [activity, person, now]
  )
  const nameOf = (id: string): string => people.find((entry) => entry.id === id)?.name ?? 'Deleted person'

  const back = (
    <Button variant="ghost" size="sm" className="justify-self-start" onClick={onBack}>
      <ChevronRightIcon className="rotate-180" />
      People
    </Button>
  )

  if (!person) {
    return (
      <Frame label="Person">
        {back}
        <p className="m-0 text-body-sm text-text-2">This person’s voice was deleted. Sessions that named them keep the name.</p>
      </Frame>
    )
  }

  const open = detail?.actions.filter((item) => !item.done) ?? []
  const done = detail?.actions.filter((item) => item.done) ?? []

  return (
    <Frame label={person.name}>
      <div className="grid gap-2">
        {back}
        <header className="flex flex-wrap items-center gap-3">
          <SpeakerBadge name={person.name} slot={speakerSlot(people, person.id)} />
          <h1 className="m-0 text-display font-semibold tracking-[-0.01em]">{person.name}</h1>
          {person.self ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-label font-semibold text-brand-text">You</span>
          ) : null}
          <span className="ml-auto font-mono text-label text-text-3">
            Voice saved {dateLabel(person.createdAt)} · {plural(person.samples, 'sample')}
          </span>
        </header>
      </div>

      {loaded.state === 'failed' ? <LoadError onRetry={loaded.retry} /> : null}

      <section className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3" aria-label="Totals">
        <Tile
          label="Sessions"
          value={totals ? String(totals.sessions) : '—'}
          delta={null}
          hint={totals?.firstSeen ? `Since ${dateLabel(totals.firstSeen)}` : 'Not heard yet'}
        />
        <Tile
          label="Talk time"
          value={totals ? durationLabel(totals.talkSeconds) : '—'}
          delta={null}
          hint={totals?.sessions ? `${durationLabel(totals.talkSeconds / totals.sessions)} a session` : ' '}
        />
        <Tile label="Share of talk" value={percent(totals?.share ?? null)} delta={null} hint="In the sessions they were in" />
        <Tile
          label="Words"
          value={totals ? totals.words.toLocaleString() : '—'}
          delta={null}
          hint={totals?.pace ? `${String(totals.pace)} a minute` : plural(totals?.lines ?? 0, 'line')}
        />
        <Tile
          label="Last heard"
          value={totals?.lastSeen ? rowTime(totals.lastSeen, now) : '—'}
          delta={null}
          hint={open.length ? plural(open.length, 'open action') : 'No open actions'}
        />
      </section>

      {detail ? (
        <section className="grid gap-3" aria-label={`Talk time, last ${String(WEEKS)} weeks`}>
          <div className="flex items-baseline gap-2">
            <h2 className={heading}>Talk time</h2>
            <span className="text-label text-text-3">last {WEEKS} weeks</span>
          </div>
          <WeekChart weeks={detail.weeks} />
        </section>
      ) : null}

      <div className="grid gap-7 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
        <section className="grid content-start gap-2" aria-label="Sessions">
          <h2 className={heading}>Sessions</h2>
          {detail?.sessions.length ? (
            <ul className="m-0 grid list-none p-0">
              {detail.sessions.map((session) => (
                <li key={session.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    className={cn(rowButton, 'grid grid-cols-[16px_minmax(0,1fr)_96px_auto] items-center gap-x-2.5 px-1.5 py-2')}
                    onClick={() => onOpenSession(session.id)}
                  >
                    <NoteIcon className="text-text-3" />
                    <span className="min-w-0">
                      <span className="block truncate text-body-sm font-semibold">{session.title || 'Untitled'}</span>
                      <span className="block truncate text-label text-text-3">
                        {durationLabel(session.theirSeconds)} talking
                        {session.with.length ? ` · with ${session.with.map(nameOf).join(', ')}` : ''}
                      </span>
                    </span>
                    <ShareBar share={session.share} />
                    <span className="font-mono text-[11.5px] text-text-3">{rowTime(session.startedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-text-3">
              {detail ? `${person.name} hasn’t been heard in a session yet.` : ' '}
            </p>
          )}
        </section>

        <div className="grid content-start gap-7">
          <section className="grid content-start gap-2" aria-label="Often with">
            <h2 className={heading}>Often with</h2>
            {detail?.together.length ? (
              <ul className="m-0 grid list-none p-0">
                {detail.together.slice(0, 6).map(({ personId: id, sessions }) => {
                  const known = people.some((entry) => entry.id === id)
                  const content = (
                    <>
                      <SpeakerBadge name={nameOf(id)} slot={speakerSlot(people, id)} size={16} />
                      <span className="min-w-0 flex-1 truncate text-body-sm">{nameOf(id)}</span>
                      <span className="font-mono text-[11.5px] text-text-3">{plural(sessions, 'session')}</span>
                    </>
                  )
                  return (
                    <li key={id}>
                      {known ? (
                        <button type="button" className={cn(rowButton, 'flex items-center gap-2.5 px-1.5 py-1.5')} onClick={() => onOpenPerson(id)}>
                          {content}
                        </button>
                      ) : (
                        <span className="flex items-center gap-2.5 px-1.5 py-1.5 text-text-3">{content}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="m-0 flex items-center gap-2 text-body-sm text-text-3">
                <PeopleIcon />
                No one else saved has been in a session with them.
              </p>
            )}
          </section>

          {open.length || done.length ? (
            <section className="grid content-start gap-2" aria-label="Action items">
              <h2 className={heading}>Action items</h2>
              <ul className="m-0 grid list-none p-0">
                {[...open, ...done].slice(0, 8).map((item, index) => (
                  <li key={`${item.sessionId}-${String(index)}`}>
                    <button
                      type="button"
                      className={cn(rowButton, 'flex items-start gap-2.5 px-1.5 py-1.5')}
                      onClick={() => onOpenSession(item.sessionId)}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-4 shrink-0 place-items-center rounded-xs border-(length:--border-width)',
                          item.done ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                        )}
                        aria-label={item.done ? 'Done' : 'Open'}
                        role="img"
                      >
                        {item.done ? <CheckIcon size={12} /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className={cn('block text-body-sm', item.done && 'text-text-3 line-through')}>{item.task}</span>
                        <span className="block truncate text-label text-text-3">{item.title || 'Untitled'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {detail?.tags.length ? (
            <section className="grid content-start gap-2" aria-label="Tags">
              <h2 className={heading}>Tags</h2>
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {detail.tags.slice(0, 6).map(([tag, count]) => (
                  <li key={tag} className="grid grid-cols-[minmax(72px,120px)_minmax(0,1fr)_32px] items-center gap-2.5 text-body-sm">
                    <span className="truncate text-text-2 before:text-text-3 before:content-['#']">{tag}</span>
                    <span className="h-2 rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${String((count / (detail.tags[0]?.[1] ?? 1)) * 100)}%` }}
                      />
                    </span>
                    <span className="text-right font-mono text-[11.5px] text-text-3">{count}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </Frame>
  )
}

/** The People entry under Home in the library. */
export function PeopleLink({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        'people-link relative flex h-9 w-full items-center gap-2 border-b border-border px-3 text-body-sm font-semibold',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-brand-soft text-brand-text before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-[3px] before:bg-primary'
          : 'text-foreground hover:bg-accent'
      )}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <PeopleIcon />
      People
    </button>
  )
}


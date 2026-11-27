import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { LOW_CONFIDENCE, SURE_MATCH, type TranscriptSegment } from '../../../shared/sessionDoc'
import type { SummarySection } from '../../../shared/summarySections'
import type { OpenPage } from '../hooks/usePages'
import { clockLabel } from '../lib/format'
import { SPEAKER_HUES, speakerSlot } from '../lib/speakerTone'
import { play } from '../lib/playback'
import { axisStep, lineAt } from '../lib/timeline'
import { notify } from '../lib/toast'
import { useContextMenu } from './ContextMenu'
import { CopyIcon, PersonIcon, PlayIcon } from './Icons'
import { SpeakerName, type Certainty } from './SpeakerBadge'
import { tip } from './Tooltip'
import { Badge } from './ui/badge'

const percent = (value: number): string => `${String(Math.round(value * 1000) / 10)}%`

/** A lane colour: the speaker's hue, or the neutral one past the palette. */
function hueOf(slot: number): string {
  return slot >= SPEAKER_HUES ? 'var(--text-subtle)' : `var(--speaker-${String(slot + 1)})`
}

/** One pass over a long transcript: who spoke, when and for how long, and what needs the person. */
function useTalk(page: OpenPage) {
  return useMemo(() => {
    const lines = new Map<string, number>()
    const seconds = new Map<string, number>()
    const turns = new Map<string, TranscriptSegment[]>()
    let all = 0
    let unsure = 0
    const end = page.transcript.at(-1)?.end ?? 0
    for (const line of page.transcript) {
      const length = Math.max(0, line.end - line.start)
      all += length
      if (line.confidence !== null && line.confidence < LOW_CONFIDENCE) unsure++
      if (line.cluster === null) continue
      lines.set(line.cluster, (lines.get(line.cluster) ?? 0) + 1)
      seconds.set(line.cluster, (seconds.get(line.cluster) ?? 0) + length)
      const own = turns.get(line.cluster)
      if (own) own.push(line)
      else turns.set(line.cluster, [line])
    }
    const present = page.speakers.filter((speaker) => lines.has(speaker.id))
    const pending = present.filter((speaker) => !speaker.confirmed && (speaker.confidence ?? 0) < SURE_MATCH)
    const share = (id: string): number =>
      all ? (seconds.get(id) ?? 0) / all : (lines.get(id) ?? 0) / Math.max(1, page.transcript.length)
    return { present, pending, unsure, lines, seconds, turns, share, end }
  }, [page.transcript, page.speakers])
}

function certaintyOf(speaker: OpenPage['speakers'][number]): Certainty {
  if (speaker.confirmed || (speaker.confidence ?? 0) >= SURE_MATCH) return 'sure'
  return speaker.personId ? 'likely' : 'unknown'
}

/** A block under the notes: a caps label, like "Your notes", with no frame of its own. */
function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-2.5" aria-label={title}>
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="m-0 shrink-0 text-caps font-semibold tracking-[0.07em] text-text-3 uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

type Props = {
  page: OpenPage
  /** The summary itself (components/Summary), when there is one. */
  summary: ReactNode
  sections: SummarySection[]
  /** Opens the speaker naming popover anchored to `target`. */
  onSpeaker: (speakerId: string, target: Element) => void
  /** Seeks the transcript to the line nearest `seconds`. */
  onSeek: (seconds: number) => void
  /** The stretch of the session the transcript shows right now, in seconds. */
  view: { from: number; to: number } | null
}

/**
 * Under the notes in a meeting: the summary, then the speakers on one timeline. The timeline is
 * a map of the whole session: a time axis, a lane of turns per speaker with the summary's
 * sections as faint ticks, and a band for what the transcript shows now. Hovering reads out the
 * section and who spoke at that moment; clicking jumps there.
 */
export function SummaryPane({ page, summary, sections, onSpeaker, onSeek, view }: Props) {
  const talk = useTalk(page)
  const slot = (id: string): number => speakerSlot(page.speakers, id)
  const names = useMemo(() => new Map(page.speakers.map((speaker) => [speaker.id, speaker.name])), [page.speakers])
  const [hover, setHover] = useState<{ at: number; x: number } | null>(null)
  const end = talk.end
  const step = axisStep(end)
  const marks = end > 0 ? Array.from({ length: Math.floor(end / step) + 1 }, (_, index) => index * step) : []
  const heard = hover ? lineAt(page.transcript, hover.at) : null
  const menu = useContextMenu()

  /** Right-click on a lane: play or jump there, step through that person's turns, name them. */
  const laneMenu = (event: ReactMouseEvent, speaker: OpenPage['speakers'][number], at: number): void => {
    const turns = talk.turns.get(speaker.id) ?? []
    const next = turns.find((line) => line.start > at)
    const previous = turns.findLast((line) => line.end < at)
    const target = event.currentTarget
    menu.open(event, speaker.name, [
      {
        label: `Play from ${clockLabel(at)}`,
        icon: <PlayIcon />,
        run: () => {
          void play({ pageId: page.id, from: at, end, lines: page.transcript })
          onSeek(at)
        }
      },
      { label: `Jump to ${clockLabel(at)}`, run: () => onSeek(at) },
      'separator',
      {
        label: next ? `Next turn by ${speaker.name} · ${clockLabel(next.start)}` : `No later turn by ${speaker.name}`,
        disabled: !next,
        run: () => {
          if (next) onSeek(next.start)
        }
      },
      {
        label: previous ? `Previous turn · ${clockLabel(previous.start)}` : 'No earlier turn',
        disabled: !previous,
        run: () => {
          if (previous) onSeek(previous.start)
        }
      },
      'separator',
      {
        label: certaintyOf(speaker) === 'sure' ? `Rename ${speaker.name}…` : `Who is ${speaker.name}…`,
        icon: <PersonIcon />,
        run: () => onSpeaker(speaker.id, target)
      },
      {
        label: `Copy ${speaker.name}'s lines`,
        icon: <CopyIcon />,
        run: () => {
          window.api.copyText(turns.map((line) => `(${clockLabel(line.start)}) ${line.text}`).join('\n\n'))
          notify(`Copied ${String(turns.length)} ${turns.length === 1 ? 'line' : 'lines'}`)
        }
      }
    ])
  }
  const hoveredSection = hover ? sections.findLast((section) => section.start <= hover.at) : undefined

  return (
    <div className="summary-pane grid min-w-0 content-start gap-5 border-t border-border pt-4">
      {talk.present.length ? (
        <Block
          title={`Speakers · ${String(talk.present.length)}`}
          aside={
            // The length stays pinned to the right; the pills come and go on the inside of it.
            <>
            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {talk.pending.length ? (
                <Badge tone="warning" className="h-5">
                  {talk.pending.length} to confirm
                </Badge>
              ) : null}
              {talk.unsure ? (
                <Badge tone="warning" className="h-5">
                  {talk.unsure} unsure {talk.unsure === 1 ? 'line' : 'lines'}
                </Badge>
              ) : null}
            </span>
            {end > 0 ? <span className="shrink-0 font-mono text-[11.5px] text-text-3">{clockLabel(end)}</span> : null}
            </>
          }
        >
          <div className="grid min-w-0 grid-cols-[minmax(84px,132px)_minmax(0,1fr)_40px] gap-x-2.5">
            {/* Axis and sections: an empty label cell, the track, an empty share cell. */}
            {end > 0 ? (
              <>
                <span />
                <div className="relative h-4" aria-hidden="true">
                  {marks.map((mark) => (
                    <span
                      key={mark}
                      className="absolute bottom-0 -translate-x-1/2 font-mono text-[10.5px] leading-none text-text-3 first:translate-x-0"
                      style={{ left: percent(mark / end) }}
                    >
                      {clockLabel(mark)}
                    </span>
                  ))}
                </div>
                <span />
              </>
            ) : null}
            {/* Labels and shares sit in their own columns; the lanes share one track so the
                cursor and the "on screen" band run across all of them. */}
            <ul className="m-0 grid list-none content-start gap-1.5 p-0">
              {talk.present.map((speaker) => (
                <li key={speaker.id} className="h-5">
                  <button
                    type="button"
                    className="speaker-row h-5 w-full min-w-0 rounded-xs px-0.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    aria-haspopup="dialog"
                    {...tip(certaintyOf(speaker) === 'sure' ? 'Rename or split' : 'Name this speaker')}
                    onClick={(event) => onSpeaker(speaker.id, event.currentTarget)}
                  >
                    <SpeakerName
                      name={speaker.name}
                      slot={slot(speaker.id)}
                      certainty={certaintyOf(speaker)}
                      size={16}
                      className="max-w-full text-[12.5px]"
                    />
                  </button>
                </li>
              ))}
            </ul>
            {end > 0 ? (
              <div
                className="timeline relative grid cursor-pointer content-start gap-1.5"
                role="slider"
                tabIndex={0}
                aria-label="Speaker timeline"
                aria-valuemin={0}
                aria-valuemax={Math.round(end)}
                aria-valuenow={Math.round(view?.from ?? 0)}
                aria-valuetext={`${clockLabel(view?.from ?? 0)} of ${clockLabel(end)}`}
                onPointerMove={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  const x = Math.min(box.width, Math.max(0, event.clientX - box.left))
                  setHover({ at: (x / Math.max(1, box.width)) * end, x })
                }}
                onPointerLeave={() => setHover(null)}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  onSeek(((event.clientX - box.left) / Math.max(1, box.width)) * end)
                }}
                onKeyDown={(event) => {
                  // Arrows step 30 s from what's on screen; Home and End go to the ends.
                  const from = view?.from ?? 0
                  const to =
                    event.key === 'ArrowRight' ? from + 30 : event.key === 'ArrowLeft' ? from - 30 : event.key === 'Home' ? 0 : event.key === 'End' ? end : null
                  if (to === null) return
                  event.preventDefault()
                  onSeek(Math.min(end, Math.max(0, to)))
                }}
              >
                {talk.present.map((speaker) => (
                  <div
                    key={speaker.id}
                    className="relative h-5 overflow-hidden rounded-[3px] bg-muted"
                    onContextMenu={(event) => {
                      const box = event.currentTarget.getBoundingClientRect()
                      laneMenu(event, speaker, ((event.clientX - box.left) / Math.max(1, box.width)) * end)
                    }}
                  >
                    {(talk.turns.get(speaker.id) ?? []).map((line) => (
                      <i
                        key={line.id}
                        className="absolute inset-y-[3px] min-w-px rounded-[1px]"
                        style={{
                          left: percent(line.start / end),
                          width: percent(Math.max(0, line.end - line.start) / end),
                          background: hueOf(slot(speaker.id))
                        }}
                      />
                    ))}
                  </div>
                ))}
                {sections.map((section) => (
                  <i
                    key={`tick-${String(section.start)}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 w-px bg-text-3/40"
                    style={{ left: percent(section.start / end) }}
                  />
                ))}
                {/* Only worth drawing when the transcript shows part of the session, not nearly all of it. */}
                {view && (Math.min(end, view.to) - view.from) / end < 0.85 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-y-1 rounded-[3px] bg-primary/15"
                    style={{
                      left: percent(Math.max(0, view.from) / end),
                      width: `max(3px, ${percent(Math.max(0, Math.min(end, view.to) - view.from) / end)})`
                    }}
                  />
                ) : null}
                {hover ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-y-1 w-px bg-foreground"
                      style={{ left: hover.x }}
                    />
                    <span
                      // One fixed shape, so dragging across the lanes never makes it jump: section,
                      // time and speaker, then exactly two lines of what was said.
                      className="pointer-events-none absolute bottom-[calc(100%+8px)] z-10 grid w-[260px] grid-rows-[16px_16px_32px] gap-0.5 rounded-sm border-(length:--border-width) border-border bg-popover px-2 py-1.5 text-label text-popover-foreground shadow-md"
                      style={{ left: `clamp(0px, ${String(hover.x - 130)}px, calc(100% - 260px))` }}
                    >
                      <span className="truncate font-semibold text-foreground">{hoveredSection?.title ?? ''}</span>
                      <span className="truncate">
                        <span className="font-mono text-brand-text">{clockLabel(hover.at)}</span>
                        {heard ? (
                          <>
                            {' · '}
                            <b className="font-semibold">{heard.cluster ? (names.get(heard.cluster) ?? 'Speaker') : 'Speaker'}</b>
                          </>
                        ) : (
                          <span className="text-text-3"> · nobody speaking</span>
                        )}
                      </span>
                      <span className="line-clamp-2 overflow-hidden text-text-2">{heard?.text ?? ''}</span>
                    </span>
                  </>
                ) : null}
              </div>
            ) : (
              <span />
            )}
            <ul className="m-0 grid list-none content-start gap-1.5 p-0">
              {talk.present.map((speaker) => {
                const count = talk.lines.get(speaker.id) ?? 0
                const spoke = talk.seconds.get(speaker.id) ?? 0
                return (
                  <li
                    key={speaker.id}
                    className="h-5 text-right font-mono text-[11.5px] leading-5 tabular-nums text-text-3"
                    {...tip(`${clockLabel(spoke)} spoken · ${String(count)} ${count === 1 ? 'line' : 'lines'}`)}
                  >
                    {Math.round(talk.share(speaker.id) * 100)}%
                  </li>
                )
              })}
            </ul>
          </div>
          {menu.element}
        </Block>
      ) : null}

      {summary ? <div className="border-t border-border pt-4">{summary}</div> : null}
    </div>
  )
}

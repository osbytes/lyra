import { useMemo } from 'react'
import type { PageSummary, Settings } from '../../../shared/types'
import { LOW_CONFIDENCE, SURE_MATCH, type TranscriptSegment } from '../../../shared/sessionDoc'
import type { OpenPage } from '../hooks/usePages'
import { formatDuration, readingMinutes, relativeTime } from '../lib/format'
import { speakerTone } from '../lib/speakerTone'
import { CopyIcon, FolderIcon, PeopleIcon } from './Icons'
import { ScrollArea } from './Controls'
import { SummaryButton } from './SummaryButton'
import { TagRow } from './TagRow'
import { tip } from './Tooltip'

type Props = {
  page: OpenPage
  summary: PageSummary | undefined
  words: number
  knownTags: readonly (readonly [string, number])[]
  notesEngine: Settings['notesEngine']
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  /** Opens the speaker picker anchored to `target`. */
  onSpeaker: (speakerId: string, target: Element) => void
  onCopy: () => void
}

const percent = (value: number): string => `${String(Math.round(value * 100))}%`

const DATE: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

/**
 * The side-panel layout: a session's facts, tags and speakers beside the text instead of
 * above it. Summary first (when, how long, where it lives), then what you edit, then actions.
 */
export function DetailsPanel({
  page,
  summary,
  words,
  knownTags,
  notesEngine,
  onAddTag,
  onRemoveTag,
  onSpeaker,
  onCopy
}: Props) {
  const total = page.transcript.length
  // One pass over the transcript instead of one per speaker: long sessions have thousands of lines.
  const { present, pending, unsure, talk, all } = useMemo(() => {
    const lines = new Map<string, number>()
    const talk = new Map<string, number>()
    let all = 0
    const unsure: TranscriptSegment[] = []
    for (const line of page.transcript) {
      const length = Math.max(0, line.end - line.start)
      all += length
      if (line.confidence !== null && line.confidence < LOW_CONFIDENCE) unsure.push(line)
      if (line.cluster === null) continue
      lines.set(line.cluster, (lines.get(line.cluster) ?? 0) + 1)
      talk.set(line.cluster, (talk.get(line.cluster) ?? 0) + length)
    }
    const present = page.speakers.filter((speaker) => lines.has(speaker.id))
    const pending = present.filter(
      (speaker) => !speaker.confirmed && (speaker.confidence ?? 0) < SURE_MATCH
    )
    return { present, pending, unsure, talk: { lines, seconds: talk }, all }
  }, [page.transcript, page.speakers])

  const facts: [string, string][] = []
  if (summary) facts.push(['Started', new Date(summary.startedAt).toLocaleString(undefined, DATE)])
  if (summary?.seconds) facts.push(['Duration', formatDuration(summary.seconds * 1000)])
  if (summary) facts.push(['Edited', relativeTime(summary.updatedAt)])
  facts.push(['Words', words.toLocaleString()])
  if (words) facts.push(['Reading time', `${String(readingMinutes(words))} min`])

  return (
    <aside className="details" aria-label="Details">
      {/* In the window's top band, level with the brand and the page's toolbar. */}
      <header className="details-header drag">
        <h2>Details</h2>
      </header>
      <ScrollArea className="details-body">
      <section className="details-section">
        <dl className="details-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div>
            <dt>File</dt>
            <dd className="details-file" {...tip(page.id)}>
              {page.id}
            </dd>
          </div>
        </dl>
      </section>

      <section className="details-section">
        <h2 className="section-label">Tags</h2>
        <TagRow tags={page.tags} known={knownTags} onAdd={onAddTag} onRemove={onRemoveTag} />
      </section>

      {present.length ? (
        <section className="details-section">
          <h2 className="section-label">
            Speakers <span className="details-count">{present.length}</span>
          </h2>
          {pending.length || unsure.length ? (
            <div className="details-pills">
              {pending[0] ? (
                <button
                  type="button"
                  className="pill"
                  onClick={(event) => {
                    if (pending[0]) onSpeaker(pending[0].id, event.currentTarget)
                  }}
                >
                  {pending.length} to confirm
                </button>
              ) : null}
              {unsure.length ? (
                <span className="pill">
                  {unsure.length} unsure {unsure.length === 1 ? 'line' : 'lines'}
                </span>
              ) : null}
            </div>
          ) : null}
          <ul className="details-speakers">
            {present.map((speaker) => {
              const lineCount = talk.lines.get(speaker.id) ?? 0
              const share = all
                ? (talk.seconds.get(speaker.id) ?? 0) / all
                : lineCount / Math.max(1, total)
              const state =
                speaker.confirmed || (speaker.confidence ?? 0) >= SURE_MATCH
                  ? 'sure'
                  : speaker.personId
                    ? 'likely'
                    : 'unknown'
              return (
                <li key={speaker.id}>
                  <button
                    type="button"
                    className={`details-speaker ${state}`}
                    aria-haspopup="dialog"
                    onClick={(event) => onSpeaker(speaker.id, event.currentTarget)}
                  >
                    <span
                      className="speaker-avatar"
                      data-tone={speakerTone(page.speakers, speaker.id)}
                      aria-hidden="true"
                    >
                      {state === 'unknown' ? '?' : (speaker.name[0] ?? '?').toUpperCase()}
                    </span>
                    <span className="details-speaker-name">
                      {speaker.name}
                      {state === 'likely' ? <span className="speaker-q">?</span> : null}
                    </span>
                    <span className="details-speaker-match">
                      {speaker.confidence === null
                        ? speaker.confirmed
                          ? 'Confirmed'
                          : 'No match'
                        : `${percent(speaker.confidence)} match`}
                    </span>
                    <span className="details-speaker-share">
                      <span className="meter" aria-hidden="true">
                        <i style={{ width: percent(share) }} />
                      </span>
                      {percent(share)} of talk · {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section className="details-section">
        <h2 className="section-label">Actions</h2>
        <div className="details-actions">
          <button type="button" className="ghost-btn" onClick={onCopy}>
            <CopyIcon />
            Copy as Markdown
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void window.api.revealPage(page.id)}
          >
            <FolderIcon />
            Show in folder
          </button>
          {present.length && notesEngine !== 'off' ? (
            <SummaryButton
              pageId={page.id}
              hasSummary={!!page.summary.trim()}
              className="ghost-btn"
              icon={<PeopleIcon />}
            />
          ) : null}
        </div>
      </section>
      </ScrollArea>
    </aside>
  )
}

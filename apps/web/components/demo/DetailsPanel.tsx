'use client'

// A port of apps/lyra/src/renderer/src/components/DetailsPanel.tsx.
import { linesOf, sessionWords } from '@/lib/demo/export'
import { LOW_CONFIDENCE, percent, presentSpeakers, stateOf } from '@/lib/demo/speakers'
import { readingMinutes } from '@/lib/demo/text'
import { clock, formatStarted, relativeTime } from '@/lib/demo/time'
import { ScrollArea } from './Controls'
import { useDemo } from './DemoProvider'
import { CopyIcon, FolderIcon, PeopleIcon } from './Icons'
import { TagRow } from './TagRow'

type Props = {
  knownTags: readonly (readonly [string, number])[]
  onSpeaker: (id: string) => void
  onCopy: () => void
  onReveal: () => void
  onWriteNotes: (() => void) | null
}

export function DetailsPanel({ knownTags, onSpeaker, onCopy, onReveal, onWriteNotes }: Props) {
  const { state, current, exportContext, dispatch } = useDemo()
  const lines = linesOf(current, exportContext)
  const present = presentSpeakers(state.speakers, lines)
  const pending = present.filter((speaker) => stateOf(speaker) !== 'sure')
  const unsure = lines.filter((line) => line.confidence !== null && line.confidence < LOW_CONFIDENCE)
  const words = sessionWords(current, exportContext)
  const allTalk = lines.reduce((sum, line) => sum + Math.max(0, line.end - line.start), 0)

  const facts: [string, string][] = [['Started', formatStarted(current.startedAt)]]
  if (current.seconds) facts.push(['Duration', clock(current.seconds)])
  facts.push(['Edited', relativeTime(current.editedAt, state.now)], ['Words', words.toLocaleString('en-US')])
  if (words) facts.push(['Reading time', `${String(readingMinutes(words))} min`])

  return (
    <ScrollArea as="aside" className="details" aria-label="Details">
      <section className="details-section">
        <h2 className="section-label">Details</h2>
        <dl className="details-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div>
            <dt>File</dt>
            <dd className="details-file" title={current.id}>
              {current.id}
            </dd>
          </div>
        </dl>
      </section>

      <section className="details-section">
        <h2 className="section-label">Tags</h2>
        <TagRow
          tags={current.tags}
          known={knownTags}
          onAdd={(tag) => dispatch({ type: 'tag', tag })}
          onRemove={(tag) => dispatch({ type: 'untag', tag })}
        />
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
                  onClick={() => {
                    if (pending[0]) onSpeaker(pending[0].id)
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
              const own = lines.filter((line) => line.cluster === speaker.id)
              const talk = own.reduce((sum, line) => sum + Math.max(0, line.end - line.start), 0)
              const share = allTalk ? talk / allTalk : 0
              const state = stateOf(speaker)
              return (
                <li key={speaker.id}>
                  <button
                    type="button"
                    className={`details-speaker ${state}`}
                    onClick={() => {
                      onSpeaker(speaker.id)
                    }}
                  >
                    <span className="speaker-avatar" aria-hidden="true">
                      {state === 'unknown' ? '?' : speaker.name.charAt(0).toUpperCase()}
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
                      {percent(share)} of talk · {own.length} {own.length === 1 ? 'line' : 'lines'}
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
          <button type="button" className="ghost-btn" onClick={onReveal}>
            <FolderIcon />
            Show in folder
          </button>
          {present.length && onWriteNotes ? (
            <button type="button" className="ghost-btn" onClick={onWriteNotes}>
              <PeopleIcon />
              Rewrite meeting notes
            </button>
          ) : null}
        </div>
      </section>
    </ScrollArea>
  )
}

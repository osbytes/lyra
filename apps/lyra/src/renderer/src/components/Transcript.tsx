import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { MeetingStatus, Person, Settings } from '../../../shared/types'
import {
  LOW_CONFIDENCE,
  SURE_MATCH,
  type SpeakerEntry,
  type TranscriptSegment
} from '../../../shared/sessionDoc'
import type { NewSpeaker } from '../hooks/usePages'
import { log } from '../lib/log'
import { Floating, Switch } from './Controls'
import { CloseIcon, PlayIcon, PlusIcon } from './Icons'
import { usePeople } from './People'

/**
 * A session's transcript: one editable line per segment, speakers in the left margin, and a
 * speaker picker for naming, fixing a line, or splitting a speaker who was really two people.
 * Everything edits the session document, so undo and other windows just work.
 */

type Props = {
  pageId: string
  transcript: TranscriptSegment[]
  speakers: SpeakerEntry[]
  hasSummary: boolean
  notesEngine: Settings['notesEngine']
  onEditLine: (id: string, text: string) => void
  onAssign: (ids: readonly string[], speaker: string | NewSpeaker) => string | null
  onUndo: () => void
  /** False in the side-panel layout, where speakers are listed in the panel instead. */
  showSpeakersBar: boolean
  /** Opens the picker from outside (the side panel); a new object each time. */
  pickerRequest: { speaker: string; anchor: DOMRect } | null
}

type Picker = { speaker: string; line: string | null; anchor: DOMRect }

// --- Small helpers ------------------------------------------------------------------

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return total >= 3600
    ? `${String(Math.floor(m / 60))}:${String(m % 60).padStart(2, '0')}:${s}`
    : `${String(m)}:${s}`
}

type SpeakerState = 'sure' | 'likely' | 'unknown'

function stateOf(speaker: SpeakerEntry | undefined): SpeakerState {
  if (!speaker) return 'unknown'
  if (speaker.confirmed || (speaker.confidence ?? 0) >= SURE_MATCH) return 'sure'
  return speaker.personId ? 'likely' : 'unknown'
}

function tier(confidence: number | null): 1 | 2 | 3 {
  if (confidence === null || confidence >= SURE_MATCH) return 3
  return confidence >= LOW_CONFIDENCE ? 2 : 1
}

const percent = (value: number): string => `${String(Math.round(value * 100))}%`

function Signal({ confidence }: { confidence: number | null }) {
  const level = tier(confidence)
  const label = confidence === null ? 'voice match unknown' : `${percent(confidence)} voice match`
  return (
    <span className={`signal l${String(level)}`} role="img" aria-label={label} title={label}>
      <i />
      <i />
      <i />
    </span>
  )
}

let playing: { context: AudioContext; source: AudioBufferSourceNode } | null = null

/** Plays a stretch of the session's audio, stopping anything already playing. */
async function listen(pageId: string, start: number, end: number): Promise<boolean> {
  playing?.source.stop()
  playing = null
  const pcm = await window.api.sessionAudio(pageId, start, end)
  if (!pcm.length) return false
  const context = new AudioContext({ sampleRate: 16000 })
  const buffer = context.createBuffer(1, pcm.length, 16000)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.onended = () => {
    void context.close()
  }
  source.start()
  playing = { context, source }
  return true
}

// --- Speaker picker --------------------------------------------------------------------

type Option =
  | { kind: 'person'; person: Person; score: number | null }
  | { kind: 'new'; name: string }
  | { kind: 'keep' }

function SpeakerPicker({
  pageId,
  picker,
  speaker,
  allSpeakers,
  lines,
  people,
  onClose,
  onAssign,
  onSplit
}: {
  pageId: string
  picker: Picker
  speaker: SpeakerEntry
  allSpeakers: SpeakerEntry[]
  lines: TranscriptSegment[]
  people: Person[]
  onClose: () => void
  onAssign: Props['onAssign']
  onSplit: () => void
}) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [scope, setScope] = useState<'line' | 'all'>(picker.line ? 'line' : 'all')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const state = stateOf(speaker)
  const own = lines.filter((line) => line.cluster === speaker.id)
  const line = picker.line ? lines.find((entry) => entry.id === picker.line) : undefined
  const odd = own.filter((entry) => entry.confidence !== null && entry.confidence < LOW_CONFIDENCE)
  const matched = speaker.personId
    ? people.find((person) => person.id === speaker.personId)
    : undefined

  useEffect(() => {
    input.current?.focus()
  }, [])

  const options = useMemo((): Option[] => {
    const needle = query.trim().toLowerCase()
    const score = (person: Person): number | null =>
      speaker.matches.find((match) => match.personId === person.id)?.score ?? null
    const ranked = people
      .filter((person) => person.name.toLowerCase().includes(needle))
      .map((person) => ({ kind: 'person' as const, person, score: score(person) }))
      .sort(
        (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.person.name.localeCompare(b.person.name)
      )
    const out: Option[] = ranked
    const exact = people.some((person) => person.name.toLowerCase() === needle)
    if (needle && !exact) out.push({ kind: 'new', name: query.trim() })
    out.push({ kind: 'keep' })
    return out
  }, [people, query, speaker.matches])

  const run = async (option: Option | undefined): Promise<void> => {
    if (!option) return
    setError(null)
    try {
      if (option.kind === 'keep') {
        onClose()
        return
      }
      if (scope === 'line' && line) {
        // Just this line: move it to whoever that is, reusing their speaker if present.
        const personId = option.kind === 'person' ? option.person.id : null
        const name = option.kind === 'person' ? option.person.name : option.name
        const existing = allSpeakers.find((entry) =>
          personId ? entry.personId === personId : entry.name.toLowerCase() === name.toLowerCase()
        )
        onAssign([line.id], existing ? existing.id : { name, personId, confirmed: true })
        onClose()
        return
      }
      await window.api.assignSpeaker(
        pageId,
        speaker.id,
        option.kind === 'person' ? { personId: option.person.id } : { name: option.name, remember }
      )
      onClose()
    } catch (caught) {
      log('transcript', 'could not name speaker', String(caught))
      setError(caught instanceof Error ? caught.message : 'Could not name this speaker')
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : options.length - 1
      setHighlight((value) => (value + step) % options.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void run(options[highlight])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const title =
    scope === 'line' && line
      ? 'Who said this?'
      : state === 'likely' && matched
        ? `Is this ${matched.name}?`
        : state === 'unknown'
          ? `Who is ${speaker.name}?`
          : speaker.name
  const sample = line ?? own[0]
  const top = Math.min(picker.anchor.bottom + 8, window.innerHeight - 420)
  const left = Math.min(picker.anchor.left, window.innerWidth - 356)

  return (
    <div className="picker-layer" onMouseDown={onClose}>
      <div
        className="picker"
        role="dialog"
        aria-label={title}
        style={{ top: Math.max(8, top), left: Math.max(8, left) }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={onKeyDown}
      >
        <div className="picker-head">
          <div className="picker-title">
            <strong>{title}</strong>
            <small>
              {scope === 'line' && line
                ? `${clock(line.start)}${line.confidence === null ? '' : ` · ${percent(line.confidence)} like ${speaker.name}`}`
                : `${String(own.length)} ${own.length === 1 ? 'line' : 'lines'}${speaker.confidence === null ? '' : ` · ${percent(speaker.confidence)} voice match`}`}
            </small>
          </div>
          {sample ? (
            <button
              type="button"
              className="chip-btn"
              onClick={() => {
                void listen(pageId, sample.start, Math.min(sample.end, sample.start + 8)).then(
                  (ok) => {
                    if (!ok) setError('This session’s audio is no longer kept.')
                  }
                )
              }}
            >
              <PlayIcon />
              Listen
            </button>
          ) : null}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {line && own.length > 1 ? (
          <div className="segmented picker-scope" role="radiogroup" aria-label="Change">
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'line'}
              onClick={() => setScope('line')}
            >
              Just this line
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'all'}
              onClick={() => setScope('all')}
            >
              All {own.length} lines
            </button>
          </div>
        ) : null}

        {scope === 'all' && odd.length > 0 && odd.length < own.length ? (
          <div className="picker-hint" role="note">
            <span>
              <b>
                {odd.length} of {own.length} lines
              </b>{' '}
              sound like someone else.
            </span>
            <button type="button" className="btn" onClick={onSplit}>
              Split…
            </button>
          </div>
        ) : null}

        {scope === 'all' && state === 'likely' && matched ? (
          <div className="picker-confirm">
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                void run({ kind: 'person', person: matched, score: speaker.confidence })
              }
            >
              Yes, it’s {matched.name}
            </button>
            <button type="button" className="btn" onClick={() => input.current?.focus()}>
              Someone else
            </button>
          </div>
        ) : null}

        <label className="picker-search">
          <input
            ref={input}
            type="text"
            value={query}
            placeholder={state === 'likely' ? 'Or pick someone else…' : 'Type a name…'}
            aria-label="Name"
            aria-controls="picker-options"
            aria-activedescendant={`picker-option-${String(highlight)}`}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlight(0)
            }}
          />
        </label>

        <ul className="picker-options" id="picker-options" role="listbox" aria-label="People">
          {options.map((option, index) => (
            <li
              key={option.kind === 'person' ? option.person.id : option.kind}
              id={`picker-option-${String(index)}`}
              role="option"
              aria-selected={index === highlight}
              className={option.kind === 'person' ? 'picker-option' : 'picker-option plain'}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void run(option)}
            >
              {option.kind === 'person' ? (
                <>
                  <span className="picker-name">
                    {option.person.name}
                    {option.person.self ? ' (you)' : ''}
                  </span>
                  <span className="meter" aria-hidden="true">
                    <i style={{ width: percent(option.score ?? 0) }} />
                  </span>
                  <span className="picker-score">
                    {option.score === null ? '—' : percent(option.score)}
                  </span>
                </>
              ) : option.kind === 'new' ? (
                <span className="picker-name">
                  <PlusIcon /> Add “{option.name}” as a new person
                </span>
              ) : (
                <span className="picker-name">Leave as “{speaker.name}”</span>
              )}
            </li>
          ))}
        </ul>

        {error ? (
          <p className="picker-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="picker-foot">
          {scope === 'all' ? (
            <label className="picker-remember">
              <Switch label="Remember this voice" checked={remember} onChange={setRemember} />
              Remember this voice
            </label>
          ) : (
            <span />
          )}
          {own.length > 1 && !(scope === 'all' && odd.length > 0 && odd.length < own.length) ? (
            <button type="button" className="link-btn" onClick={onSplit}>
              Two people here? Split
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// --- Split ---------------------------------------------------------------------------------

function SplitDialog({
  speaker,
  lines,
  anchor,
  onCancel,
  onSplit
}: {
  speaker: SpeakerEntry
  lines: TranscriptSegment[]
  anchor: DOMRect
  onCancel: () => void
  onSplit: (ids: string[]) => void
}) {
  const own = useMemo(
    () =>
      lines
        .filter((line) => line.cluster === speaker.id)
        .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1)),
    [lines, speaker.id]
  )
  const [picked, setPicked] = useState(
    () =>
      new Set(
        own
          .filter((line) => line.confidence !== null && line.confidence < LOW_CONFIDENCE)
          .map((line) => line.id)
      )
  )
  const valid = picked.size > 0 && picked.size < own.length
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 440)
  const left = Math.min(anchor.left, window.innerWidth - 536)

  return (
    <div className="picker-layer" onMouseDown={onCancel}>
      <div
        className="picker split"
        role="dialog"
        aria-label={`Split ${speaker.name}`}
        style={{ top: Math.max(8, top), left: Math.max(8, left) }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <strong>Split {speaker.name} into two speakers</strong>
        <p>
          Tick the lines someone else said. Lyra ticked the ones whose voice is furthest from the
          rest.
        </p>
        <ul className="split-list">
          {own.map((line) => (
            <li key={line.id}>
              <label className={picked.has(line.id) ? 'split-row on' : 'split-row'}>
                <input
                  type="checkbox"
                  checked={picked.has(line.id)}
                  onChange={() => {
                    setPicked((current) => {
                      const next = new Set(current)
                      if (next.has(line.id)) next.delete(line.id)
                      else next.add(line.id)
                      return next
                    })
                  }}
                />
                <span className="split-time">{clock(line.start)}</span>
                <span className="split-text">{line.text}</span>
                <span className="split-score">
                  {line.confidence === null ? '—' : percent(line.confidence)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="picker-foot">
          <span className="split-count">
            {picked.size
              ? `${String(picked.size)} ${picked.size === 1 ? 'line goes' : 'lines go'} to a new speaker you can name next.`
              : 'Nothing ticked.'}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!valid}
            onClick={() => onSplit([...picked])}
          >
            Split
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Status --------------------------------------------------------------------------------

function statusLabel(status: MeetingStatus): string {
  const pct = `${String(Math.round(status.progress * 100))}%`
  switch (status.state) {
    case 'downloading':
      return `Downloading ${status.message ?? 'speaker models'}… ${pct}`
    case 'diarizing':
      return 'Finding who spoke when…'
    case 'transcribing':
      return `Transcribing each speaker… ${pct}`
    case 'summarizing':
      return 'Writing meeting notes…'
    case 'error':
      return `Couldn’t label speakers: ${status.message ?? 'unknown error'}`
    case 'done':
      return 'Speakers labeled'
  }
}

/** Latest processing status for `pageId`, cleared a moment after it finishes. */
export function useMeetingStatus(pageId: string | undefined): MeetingStatus | null {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    setStatus(null)
    return window.api.onMeetingStatus((next) => {
      if (next.pageId === pageId) setStatus(next)
    })
  }, [pageId])
  useEffect(() => {
    if (status?.state !== 'done') return
    const timer = setTimeout(() => {
      setStatus(null)
    }, 2500)
    return () => {
      clearTimeout(timer)
    }
  }, [status])
  return status
}

// --- Transcript ----------------------------------------------------------------------------

export function Transcript({
  pageId,
  transcript,
  speakers,
  hasSummary,
  notesEngine,
  onEditLine,
  onAssign,
  onUndo,
  showSpeakersBar,
  pickerRequest
}: Props) {
  const people = usePeople()
  const status = useMeetingStatus(pageId)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [split, setSplit] = useState<{ speaker: string; anchor: DOMRect } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const byId = useMemo(() => new Map(speakers.map((speaker) => [speaker.id, speaker])), [speakers])
  const busy = !!status && status.state !== 'done' && status.state !== 'error'
  const labeled = transcript.some((line) => line.cluster !== null)
  const present = speakers.filter((speaker) =>
    transcript.some((line) => line.cluster === speaker.id)
  )
  const pending = present.filter((speaker) => stateOf(speaker) !== 'sure')
  const unsure = transcript.filter((line) => tier(line.confidence) === 1)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!pickerRequest) return
    setSplit(null)
    setPicker({ speaker: pickerRequest.speaker, line: null, anchor: pickerRequest.anchor })
  }, [pickerRequest])

  const openPicker = (speaker: string, line: string | null, target: Element): void => {
    setSplit(null)
    setPicker({ speaker, line, anchor: target.getBoundingClientRect() })
  }

  const pickedSpeaker = picker ? byId.get(picker.speaker) : undefined
  const splitSpeaker = split ? byId.get(split.speaker) : undefined

  return (
    <section className="transcript" aria-label="Transcript">
      <div className={showSpeakersBar ? 'speakers-bar' : 'speakers-bar status-only'}>
        <span className="speakers-label">{labeled ? 'Speakers' : 'Transcript'}</span>
        {present.map((speaker) => (
          <button
            key={speaker.id}
            type="button"
            className={`speaker-chip ${stateOf(speaker)}`}
            aria-haspopup="dialog"
            aria-expanded={picker?.speaker === speaker.id && !picker.line}
            title={
              stateOf(speaker) === 'likely' && speaker.confidence !== null
                ? `${percent(speaker.confidence)} voice match — click to confirm`
                : stateOf(speaker) === 'unknown'
                  ? 'No saved voice matched — click to name'
                  : speaker.name
            }
            onClick={(event) => openPicker(speaker.id, null, event.currentTarget)}
          >
            <span className="speaker-avatar" aria-hidden="true">
              {stateOf(speaker) === 'unknown' ? '?' : (speaker.name[0] ?? '?').toUpperCase()}
            </span>
            {speaker.name}
            {stateOf(speaker) === 'likely' ? <span className="speaker-q">?</span> : null}
          </button>
        ))}
        <span className="speakers-tools">
          {status && status.state !== 'done' ? (
            <span
              className={status.state === 'error' ? 'meeting-status is-error' : 'meeting-status'}
            >
              {statusLabel(status)}
            </span>
          ) : null}
          {pending.length ? (
            <button
              type="button"
              className="pill"
              onClick={(event) => {
                const first = pending[0]
                if (first) openPicker(first.id, null, event.currentTarget)
              }}
            >
              {pending.length} to confirm
            </button>
          ) : null}
          {unsure.length ? (
            <button
              type="button"
              className="pill"
              title="Lines whose voice doesn’t match their speaker well"
              onClick={(event) => {
                const first = unsure[0]
                if (first?.cluster) openPicker(first.cluster, first.id, event.currentTarget)
              }}
            >
              {unsure.length} unsure {unsure.length === 1 ? 'line' : 'lines'}
            </button>
          ) : null}
          {notesEngine !== 'off' && labeled ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                window.api.generateNotes(pageId).catch(() => {
                  // Shown through the meeting status line.
                })
              }}
            >
              {hasSummary ? 'Rewrite notes' : 'Write notes'}
            </button>
          ) : null}
        </span>
      </div>

      <div className="lines">
        {transcript.map((line, index) => {
          const speaker = line.cluster ? byId.get(line.cluster) : undefined
          const continues = index > 0 && transcript[index - 1]?.cluster === line.cluster
          const level = tier(line.confidence)
          const state = stateOf(speaker)
          return (
            <div
              key={line.id}
              className={[
                'line',
                continues ? 'continues' : '',
                level === 1 ? 'low' : '',
                picker?.line === line.id ? 'picked' : ''
              ].join(' ')}
            >
              <div className="gutter">
                {line.cluster ? (
                  <button
                    type="button"
                    className={`who ${state}`}
                    title="Change who said this"
                    onClick={(event) => {
                      if (line.cluster) openPicker(line.cluster, line.id, event.currentTarget)
                    }}
                  >
                    {speaker?.name ?? 'Speaker'}
                    {state === 'likely' ? '?' : ''}
                  </button>
                ) : (
                  <span className="who unknown">Live</span>
                )}
                <span className="line-meta">
                  <button
                    type="button"
                    className="line-play"
                    aria-label={`Listen from ${clock(line.start)}`}
                    title="Listen"
                    onClick={() => void listen(pageId, line.start, line.end)}
                  >
                    <PlayIcon />
                    {clock(line.start)}
                  </button>
                  {line.cluster ? <Signal confidence={line.confidence} /> : null}
                  {level < 3 && line.confidence !== null ? (
                    <span className={level === 1 ? 'line-pct low' : 'line-pct'}>
                      {percent(line.confidence)}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="line-body">
                <textarea
                  className="line-text"
                  value={line.text}
                  rows={1}
                  spellCheck
                  aria-label={`Line at ${clock(line.start)}, ${speaker?.name ?? 'speaker'}`}
                  onChange={(event) => onEditLine(line.id, event.target.value)}
                />
                {line.edited ? (
                  <button
                    type="button"
                    className="edited-mark"
                    title={`Original: ${line.original}`}
                    onClick={() => onEditLine(line.id, line.original)}
                  >
                    Edited · show original
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {picker && pickedSpeaker ? (
        <Floating>
          <SpeakerPicker
            key={`${picker.speaker}:${picker.line ?? ''}`}
            pageId={pageId}
            picker={picker}
            speaker={pickedSpeaker}
            allSpeakers={speakers}
            lines={transcript}
            people={people}
            onClose={() => setPicker(null)}
            onAssign={onAssign}
            onSplit={() => {
              setSplit({ speaker: picker.speaker, anchor: picker.anchor })
              setPicker(null)
            }}
          />
        </Floating>
      ) : null}

      {split && splitSpeaker ? (
        <Floating>
          <SplitDialog
            speaker={splitSpeaker}
            lines={transcript}
            anchor={split.anchor}
            onCancel={() => setSplit(null)}
            onSplit={(ids) => {
              const blank = `Speaker ${String(speakers.length + 1)}`
              const created = onAssign(ids, { name: blank, personId: null, confirmed: false })
              setToast(
                `Split ${splitSpeaker.name} · ${String(ids.length)} ${ids.length === 1 ? 'line' : 'lines'} moved to ${blank}`
              )
              setSplit(null)
              if (created) setPicker({ speaker: created, line: null, anchor: split.anchor })
            }}
          />
        </Floating>
      ) : null}

      {toast ? (
        <Floating>
          <div className="transcript-toast toast" role="status">
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => {
                onUndo()
                setToast(null)
              }}
            >
              Undo
            </button>
          </div>
        </Floating>
      ) : null}
    </section>
  )
}

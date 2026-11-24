import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { MeetingStatus, Person, Settings } from '../../../shared/types'
import {
  LOW_CONFIDENCE,
  SURE_MATCH,
  type SpeakerEntry,
  type TranscriptSegment
} from '../../../shared/sessionDoc'
import type { TranscriptEdit } from '../../../shared/transcriptOverlay'
import type { NewSpeaker } from '../hooks/usePages'
import { log } from '../lib/log'
import { notify } from '../lib/toast'
import { useContextMenu } from './ContextMenu'
import { speakerTone } from '../lib/speakerTone'
import { Floating, ScrollArea, Switch } from './Controls'
import { CloseIcon, PlayIcon, PlusIcon, StopIcon } from './Icons'
import { usePeople } from './People'
import {
  CorrectField,
  editAt,
  LineMenu,
  LineRewrite,
  LineText,
  readSelection,
  SelectionBar,
  type Actions,
  type LineSelection,
  type MenuRequest
} from './TranscriptEditing'
import { tip } from './Tooltip'

/**
 * A session's transcript: one locked line per segment, speakers in the left margin, and a
 * speaker picker for naming, fixing a line, or splitting a speaker who was really two people.
 * The raw words are never typed over: corrections, removals and highlights are an overlay made
 * from the selection toolbar or the right-click menu, and "Raw" shows exactly what was heard.
 * Everything edits the session document, so undo and other windows just work.
 */

type Props = {
  pageId: string
  transcript: TranscriptSegment[]
  speakers: SpeakerEntry[]
  hasSummary: boolean
  notesEngine: Settings['notesEngine']
  onEditLine: (id: string, text: string) => void
  onEditOverlay: (id: string, edits: readonly TranscriptEdit[]) => void
  /** Adds words from the transcript to the notes. */
  onQuote: (line: TranscriptSegment, text: string) => void
  onAssign: (ids: readonly string[], speaker: string | NewSpeaker) => string | null
  /** Names a speaker in the document (after main has worked out who it is). */
  onName: (id: string, name: string, personId: string | null) => void
  onUndo: () => void
  /** False in the side-panel layout, where speakers are listed in the panel instead. */
  showSpeakersBar: boolean
  /** Opens the picker from outside (the side panel); a new object each time. */
  pickerRequest: { speaker: string; anchor: DOMRect } | null
  /** While recording into the transcript: the words not yet confirmed (null when not). */
  live: string | null
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
    <span className={`signal l${String(level)}`} role="img" aria-label={label} {...tip(label)}>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * One clip plays at a time, app-wide. `key` says which button started it (a line id, or the
 * picker), so that button can show Stop; every Listen button reads this through `usePlayback`.
 */
type Playing = { key: string; context: AudioContext; source: AudioBufferSourceNode }
let playing: Playing | null = null
const playbackListeners = new Set<(key: string | null) => void>()

function setPlaying(next: Playing | null): void {
  playing = next
  for (const listener of playbackListeners) listener(next?.key ?? null)
}

function stopPlayback(): void {
  const current = playing
  if (!current) return
  setPlaying(null)
  current.source.onended = null
  try {
    current.source.stop()
  } catch {
    // Already finished.
  }
  void current.context.close()
}

/** Plays a stretch of the session's audio, stopping anything already playing. */
async function listen(key: string, pageId: string, start: number, end: number): Promise<boolean> {
  stopPlayback()
  const pcm = await window.api.sessionAudio(pageId, start, end)
  if (!pcm.length) return false
  const context = new AudioContext({ sampleRate: 16000 })
  const buffer = context.createBuffer(1, pcm.length, 16000)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  const entry: Playing = { key, context, source }
  source.onended = () => {
    if (playing === entry) setPlaying(null)
    void context.close()
  }
  source.start()
  setPlaying(entry)
  return true
}

/** Which clip is playing (by key), kept in sync across every Listen button. */
function usePlayback(): string | null {
  const [key, setKey] = useState<string | null>(playing?.key ?? null)
  useEffect(() => {
    playbackListeners.add(setKey)
    return () => {
      playbackListeners.delete(setKey)
    }
  }, [])
  return key
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
  onName,
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
  onName: Props['onName']
  onSplit: () => void
}) {
  const [query, setQuery] = useState('')
  const nowPlaying = usePlayback()
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
      const who = await window.api.resolveSpeaker(
        pageId,
        speaker.id,
        option.kind === 'person' ? { personId: option.person.id } : { name: option.name, remember }
      )
      onName(speaker.id, who.name, who.personId)
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
      <ScrollArea
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
              aria-pressed={nowPlaying === 'picker'}
              onClick={() => {
                if (nowPlaying === 'picker') {
                  stopPlayback()
                  return
                }
                void listen('picker', pageId, sample.start, Math.min(sample.end, sample.start + 8)).then(
                  (ok) => {
                    if (!ok) setError('This session’s audio is no longer kept.')
                  }
                )
              }}
            >
              {nowPlaying === 'picker' ? <StopIcon /> : <PlayIcon />}
              {nowPlaying === 'picker' ? 'Stop' : 'Listen'}
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
                    {option.score === null ? '–' : percent(option.score)}
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
      </ScrollArea>
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
      <ScrollArea
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
        <ScrollArea as="ul" className="split-list">
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
                  {line.confidence === null ? '–' : percent(line.confidence)}
                </span>
              </label>
            </li>
          ))}
        </ScrollArea>
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
      </ScrollArea>
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
      return 'Writing the summary…'
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
  onEditOverlay,
  onQuote,
  onAssign,
  onName,
  onUndo,
  showSpeakersBar,
  pickerRequest,
  live
}: Props) {
  const people = usePeople()
  const nowPlaying = usePlayback()
  const status = useMeetingStatus(pageId)
  // Leaving the session (or closing it) stops whatever is playing from it.
  useEffect(() => stopPlayback, [pageId])
  const [picker, setPicker] = useState<Picker | null>(null)
  const [split, setSplit] = useState<{ speaker: string; anchor: DOMRect } | null>(null)
  const byId = useMemo(() => new Map(speakers.map((speaker) => [speaker.id, speaker])), [speakers])
  const busy = !!status && status.state !== 'done' && status.state !== 'error'
  const labeled = transcript.some((line) => line.cluster !== null)
  const present = speakers.filter((speaker) =>
    transcript.some((line) => line.cluster === speaker.id)
  )
  const pending = present.filter((speaker) => stateOf(speaker) !== 'sure')
  const unsure = transcript.filter((line) => tier(line.confidence) === 1)
  const editedLines = transcript.filter((line) => line.edits.length > 0).length

  const linesRef = useRef<HTMLDivElement>(null)
  const [raw, setRaw] = useState(false)
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [correcting, setCorrecting] = useState<LineSelection | null>(null)
  const [rewriting, setRewriting] = useState<string | null>(null)
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript

  // The toolbar follows the selection inside the transcript's lines.
  useEffect(() => {
    if (raw) {
      setSelection(null)
      return
    }
    const onChange = (): void => {
      setSelection(readSelection(linesRef.current, transcriptRef.current))
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [raw])

  /** After an edit: drop the selection and keep focus here, so Ctrl+Z undoes it. */
  const settle = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    linesRef.current?.focus({ preventScroll: true })
  }, [])

  const actions: Actions = {
    setEdits: (id, next) => {
      onEditOverlay(id, next)
      settle()
    },
    rewrite: (id) => {
      settle()
      setRewriting(id)
    },
    quote: (line, text) => {
      onQuote(line, text)
      settle()
      notify('Added to your notes')
    },
    copy: (text) => {
      window.api.copyText(text)
      settle()
      notify('Copied')
    },
    listen: (line) => {
      void listen(line.id, pageId, line.start, line.end)
    },
    speaker: (line, anchor) => {
      if (!line.cluster) return
      setSplit(null)
      setPicker({ speaker: line.cluster, line: line.id, anchor })
    }
  }

  const onContextMenu = (event: ReactMouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const id = event.target.closest<HTMLElement>('[data-line]')?.dataset.line
    if (!id || rewriting === id) return
    event.preventDefault()
    const picked = readSelection(linesRef.current, transcript)
    const inLine = picked?.line === id ? picked : null
    setMenu({
      line: id,
      span: inLine?.span ?? null,
      edit: inLine ? null : editAt(event.target),
      rect: inLine?.rect ?? null,
      x: event.clientX,
      y: event.clientY
    })
  }
  const lineById = (id: string): TranscriptSegment | undefined =>
    transcript.find((entry) => entry.id === id)
  const selectedLine = selection ? lineById(selection.line) : undefined
  const menuLine = menu ? lineById(menu.line) : undefined
  const correctingLine = correcting ? lineById(correcting.line) : undefined

  useEffect(() => {
    if (!pickerRequest) return
    setSplit(null)
    setPicker({ speaker: pickerRequest.speaker, line: null, anchor: pickerRequest.anchor })
  }, [pickerRequest])

  const openPicker = (speaker: string, line: string | null, target: Element): void => {
    setSplit(null)
    setPicker({ speaker, line, anchor: target.getBoundingClientRect() })
  }

  const speakerMenu = useContextMenu()
  const pickedSpeaker = picker ? byId.get(picker.speaker) : undefined
  const splitSpeaker = split ? byId.get(split.speaker) : undefined

  return (
    <section className={raw ? 'transcript is-raw' : 'transcript'} aria-label="Transcript">
      <div className="transcript-head">
        <h2 className="section-label">Transcript</h2>
        <span className="transcript-hint">
          {raw
            ? 'Exactly what was heard. Your edits are kept; switch back to see them.'
            : 'Select words or right-click a line to correct, remove or highlight.'}
        </span>
        <div className="segmented transcript-mode" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={!raw} onClick={() => setRaw(false)}>
            Edited{editedLines ? ` · ${String(editedLines)}` : ''}
          </button>
          <button type="button" role="radio" aria-checked={raw} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </div>
      <div className={showSpeakersBar ? 'speakers-bar' : 'speakers-bar status-only'}>
        <span className="speakers-label">{labeled ? 'Speakers' : 'Live'}</span>
        {present.map((speaker) => (
          <button
            key={speaker.id}
            type="button"
            className={`speaker-chip ${stateOf(speaker)}`}
            aria-haspopup="dialog"
            aria-expanded={picker?.speaker === speaker.id && !picker.line}
            {...tip(
              stateOf(speaker) === 'likely' && speaker.confidence !== null
                ? `${percent(speaker.confidence)} voice match · click to confirm`
                : stateOf(speaker) === 'unknown'
                  ? 'No saved voice matched · click to name'
                  : speaker.name
            )}
            onClick={(event) => openPicker(speaker.id, null, event.currentTarget)}
            onContextMenu={(event) => {
              const target = event.currentTarget
              speakerMenu.open(event, speaker.name, [
                {
                  label: stateOf(speaker) === 'sure' ? 'Rename…' : 'Who is this…',
                  run: () => openPicker(speaker.id, null, target)
                },
                {
                  label: 'Split into two speakers…',
                  run: () => {
                    setPicker(null)
                    setSplit({ speaker: speaker.id, anchor: target.getBoundingClientRect() })
                  }
                }
              ])
            }}
          >
            <span
              className="speaker-avatar"
              data-tone={speakerTone(speakers, speaker.id)}
              aria-hidden="true"
            >
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
              {...tip('Lines whose voice doesn’t match their speaker well')}
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
              {hasSummary ? 'Rewrite summary' : 'Write summary'}
            </button>
          ) : null}
        </span>
      </div>

      <div className="lines" ref={linesRef} tabIndex={-1} onContextMenu={onContextMenu}>
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
                picker?.line === line.id ? 'picked' : '',
                nowPlaying === line.id ? 'playing' : ''
              ].join(' ')}
            >
              <div className="gutter">
                {line.cluster ? (
                  <button
                    type="button"
                    className={`who ${state}`}
                    {...tip('Change who said this')}
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
                    aria-pressed={nowPlaying === line.id}
                    aria-label={
                      nowPlaying === line.id ? 'Stop playback' : `Listen from ${clock(line.start)}`
                    }
                    {...tip(nowPlaying === line.id ? 'Stop' : 'Listen')}
                    onClick={() => {
                      if (nowPlaying === line.id) stopPlayback()
                      else void listen(line.id, pageId, line.start, line.end)
                    }}
                  >
                    {nowPlaying === line.id ? <StopIcon /> : <PlayIcon />}
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
                {rewriting === line.id && !raw ? (
                  <LineRewrite
                    line={line}
                    onSave={(text) => onEditLine(line.id, text)}
                    onDone={() => {
                      setRewriting(null)
                      linesRef.current?.focus({ preventScroll: true })
                    }}
                  />
                ) : (
                  <LineText
                    line={line}
                    raw={raw}
                    label={`Line at ${clock(line.start)}, ${speaker?.name ?? 'speaker'}`}
                  />
                )}
              </div>
            </div>
          )
        })}
        {live !== null ? (
          <div className="line live-line" aria-live="polite">
            <div className="gutter">
              <span className="who unknown">Listening</span>
            </div>
            <div className="line-body">
              <p className="line-text live-text">
                <span className="ghost">{live}</span>
                <span className="transcriber-caret" />
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {selection && selectedLine && !menu && !correcting && !rewriting ? (
        <Floating>
          <SelectionBar
            line={selectedLine}
            selection={selection}
            actions={actions}
            onCorrect={() => setCorrecting(selection)}
          />
        </Floating>
      ) : null}

      {speakerMenu.element}
      {menu && menuLine ? (
        <LineMenu
          line={menuLine}
          request={menu}
          raw={raw}
          actions={actions}
          onCorrect={(span, rect) => setCorrecting({ line: menuLine.id, span, rect })}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {correcting && correctingLine ? (
        <Floating>
          <CorrectField
            line={correctingLine}
            span={correcting.span}
            rect={correcting.rect}
            onApply={(next) => onEditOverlay(correctingLine.id, next)}
            onDone={() => {
              setCorrecting(null)
              settle()
            }}
          />
        </Floating>
      ) : null}

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
            onName={onName}
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
              notify(
                `Split ${splitSpeaker.name} · ${String(ids.length)} ${ids.length === 1 ? 'line' : 'lines'} moved to ${blank}`,
                { label: 'Undo', run: onUndo }
              )
              setSplit(null)
              if (created) setPicker({ speaker: created, line: null, anchor: split.anchor })
            }}
          />
        </Floating>
      ) : null}

    </section>
  )
}

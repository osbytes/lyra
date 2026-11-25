import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { Person, Settings } from '../../../shared/types'
import {
  LOW_CONFIDENCE,
  SURE_MATCH,
  type SpeakerEntry,
  type TranscriptSegment
} from '../../../shared/sessionDoc'
import type { TranscriptEdit } from '../../../shared/transcriptOverlay'
import type { NewSpeaker } from '../hooks/usePages'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useMeetingStatus } from '../hooks/useMeetingStatus'
import { rovingIndex } from '../lib/focus'
import { clockLabel as clock } from '../lib/format'
import { log } from '../lib/log'
import { statusBusy, statusLabel, unusedSpeakerName } from '../lib/status'
import { notify } from '../lib/toast'
import { useContextMenu } from './ContextMenu'
import { speakerTone } from '../lib/speakerTone'
import { Floating, ScrollArea, Segmented, Switch } from './Controls'
import { CloseIcon, PlayIcon, PlusIcon, StopIcon } from './Icons'
import { usePeople } from './People'
import { SummaryButton } from './SummaryButton'
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
  /** While recording into the transcript: whether speech is being transcribed (null when not). */
  transcribing: Pending | null
}

type Picker = { speaker: string; line: string | null; anchor: DOMRect }

/** Where transcription stands while recording: speech waiting for Whisper, or the last of it. */
export type Pending = { working: boolean; finishing: boolean }

/**
 * Where the next lines will appear while recording. Nothing that might still change is shown:
 * each stretch of speech lands as finished lines once it's transcribed, and until then this row
 * says Lyra has heard it and is on it.
 */
function PendingLine({ pending }: { pending: Pending }) {
  const working = pending.finishing || pending.working
  const label = pending.finishing ? 'Finishing' : working ? 'Transcribing' : 'Listening'
  return (
    <div className="line pending-line" role="status" aria-live="polite">
      <div className="gutter">
        <span className="who unknown">{label}</span>
      </div>
      <div className="line-body">
        <p className="line-text pending-text">
          <span className={`pending-dots${working ? ' is-working' : ''}`} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </p>
      </div>
    </div>
  )
}

// --- Small helpers ------------------------------------------------------------------

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
/** Bumped by every stop and every new Listen, so a clip still loading knows it was superseded. */
let playbackRequest = 0
const playbackListeners = new Set<(key: string | null) => void>()

function setPlaying(next: Playing | null): void {
  playing = next
  for (const listener of playbackListeners) listener(next?.key ?? null)
}

function stopPlayback(): void {
  playbackRequest++
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

const AUDIO_GONE = 'This session’s audio is no longer kept.'

/**
 * Plays a stretch of the session's audio, stopping anything already playing. False when the
 * audio isn't kept any more; a request overtaken by a newer click (or Stop) just does nothing.
 */
async function listen(key: string, pageId: string, start: number, end: number): Promise<boolean> {
  stopPlayback()
  const request = playbackRequest
  const pcm = await window.api.sessionAudio(pageId, start, end)
  if (request !== playbackRequest) return true
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

/** Listen for a transcript line, with the picker's error as a toast when there's no audio. */
function listenToLine(pageId: string, line: TranscriptSegment): void {
  listen(line.id, pageId, line.start, line.end).then(
    (ok) => {
      if (!ok) notify(AUDIO_GONE)
    },
    (error: unknown) => {
      log('transcript', 'could not play a line', String(error))
      notify('Couldn’t play this line.')
    }
  )
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

/**
 * After one line moves to another speaker, offers to move the old speaker's other lines that
 * sound like it, so one correction fixes every line the labeling got wrong the same way.
 */
function offerSimilarLines(
  pageId: string,
  moved: string,
  from: string,
  to: string,
  name: string,
  onAssign: Props['onAssign']
): void {
  window.api
    .similarLines(pageId, [moved], from)
    .then((ids) => {
      if (ids.length === 0) return
      const count = ids.length === 1 ? '1 more line sounds' : `${String(ids.length)} more lines sound`
      notify(`${count} like ${name}`, { label: 'Move them', run: () => void onAssign(ids, to) })
    })
    .catch((error: unknown) => {
      log('transcript', 'could not find similar lines', String(error))
    })
}

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
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, true)
  const state = stateOf(speaker)
  const own = lines.filter((line) => line.cluster === speaker.id)
  const line = picker.line ? lines.find((entry) => entry.id === picker.line) : undefined
  const odd = own.filter((entry) => entry.confidence !== null && entry.confidence < LOW_CONFIDENCE)
  const matched = speaker.personId
    ? people.find((person) => person.id === speaker.personId)
    : undefined

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
        const created = onAssign([line.id], existing ? existing.id : { name, personId, confirmed: true })
        onClose()
        const to = existing?.id ?? created
        if (to) offerSimilarLines(pageId, line.id, speaker.id, to, name, onAssign)
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
    if (event.defaultPrevented) return
    // The list keys belong to the name field; elsewhere (a button, the scope) they do their own job.
    const inField = event.target === input.current
    if (inField && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : options.length - 1
      setHighlight((value) => (value + step) % options.length)
    } else if (inField && event.key === 'Enter') {
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
        ref={dialog}
        className="picker"
        role="dialog"
        aria-modal="true"
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
                listen('picker', pageId, sample.start, Math.min(sample.end, sample.start + 8)).then(
                  (ok) => {
                    if (!ok) setError(AUDIO_GONE)
                  },
                  (caught: unknown) => {
                    log('transcript', 'could not play a sample', String(caught))
                    setError('Couldn’t play this sample.')
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
          <Segmented
            className="picker-scope"
            label="Change"
            value={scope}
            options={[
              { value: 'line', label: 'Just this line' },
              { value: 'all', label: `All ${String(own.length)} lines` }
            ]}
            onChange={setScope}
          />
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
            data-autofocus
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
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, true)
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 440)
  const left = Math.min(anchor.left, window.innerWidth - 536)

  return (
    <div className="picker-layer" onMouseDown={onCancel}>
      <ScrollArea
        ref={dialog}
        className="picker split"
        role="dialog"
        aria-modal="true"
        aria-label={`Split ${speaker.name}`}
        style={{ top: Math.max(8, top), left: Math.max(8, left) }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onCancel()
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

// --- One line ------------------------------------------------------------------------------

/** What a line does through its parent; one stable object, so lines can skip re-rendering. */
type LineHandlers = {
  openPicker: (speaker: string, line: string, target: Element) => void
  listen: (line: TranscriptSegment) => void
  save: (id: string, text: string) => void
  doneRewriting: (id: string) => void
  focused: (id: string) => void
}

type LineProps = {
  line: TranscriptSegment
  speaker: SpeakerEntry | undefined
  continues: boolean
  picked: boolean
  playing: boolean
  rewriting: boolean
  /** The list's one tab stop (roving focus). */
  tabbable: boolean
  /** Id of the text telling screen readers which keys work on a line. */
  hint: string
  handlers: LineHandlers
}

/**
 * A transcript line. Memoized: typing in the notes re-renders the page, and a long meeting has
 * thousands of lines that haven't changed.
 */
const TranscriptLine = memo(function TranscriptLine({
  line,
  speaker,
  continues,
  picked,
  playing,
  rewriting,
  tabbable,
  hint,
  handlers
}: LineProps) {
  const id = useId()
  const level = tier(line.confidence)
  const state = stateOf(speaker)
  return (
    <div
      className={[
        'line',
        continues ? 'continues' : '',
        level === 1 ? 'low' : '',
        picked ? 'picked' : '',
        playing ? 'playing' : ''
      ].join(' ')}
      data-row={line.id}
      role="group"
      aria-labelledby={`${id}-label ${id}-text`}
      aria-describedby={hint}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => handlers.focused(line.id)}
    >
      <div className="gutter">
        {line.cluster ? (
          <button
            type="button"
            className={`who ${state}`}
            {...tip('Change who said this')}
            onClick={(event) => {
              if (line.cluster) handlers.openPicker(line.cluster, line.id, event.currentTarget)
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
            aria-pressed={playing}
            aria-label={playing ? 'Stop playback' : `Listen from ${clock(line.start)}`}
            {...tip(playing ? 'Stop' : 'Listen')}
            onClick={() => {
              if (playing) stopPlayback()
              else handlers.listen(line)
            }}
          >
            {playing ? <StopIcon /> : <PlayIcon />}
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
        {/* Not drawn: names the focused line for screen readers (time and speaker, then words). */}
        <span id={`${id}-label`} hidden>
          {`${clock(line.start)}, ${speaker?.name ?? 'Live'}:`}
        </span>
        {rewriting ? (
          <LineRewrite
            line={line}
            onSave={(text) => handlers.save(line.id, text)}
            onDone={() => handlers.doneRewriting(line.id)}
          />
        ) : (
          <LineText line={line} id={`${id}-text`} />
        )}
      </div>
    </div>
  )
})

/** The row element for a line id inside `root`. */
function rowOf(root: HTMLElement | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null
}

/** How long after a keyboard-opened line menu the native contextmenu event is ignored. */
const KEYBOARD_MENU_MS = 600

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
  transcribing
}: Props) {
  const people = usePeople()
  const nowPlaying = usePlayback()
  const status = useMeetingStatus(pageId)
  // Leaving the session (or closing it) stops whatever is playing from it.
  useEffect(() => stopPlayback, [pageId])
  const [picker, setPicker] = useState<Picker | null>(null)
  const [split, setSplit] = useState<{ speaker: string; anchor: DOMRect } | null>(null)
  const byId = useMemo(() => new Map(speakers.map((speaker) => [speaker.id, speaker])), [speakers])
  const labeled = useMemo(() => transcript.some((line) => line.cluster !== null), [transcript])
  const present = useMemo(() => {
    const heard = new Set<string>()
    for (const line of transcript) if (line.cluster !== null) heard.add(line.cluster)
    return speakers.filter((speaker) => heard.has(speaker.id))
  }, [speakers, transcript])
  const pending = useMemo(() => present.filter((speaker) => stateOf(speaker) !== 'sure'), [present])
  const unsure = useMemo(() => transcript.filter((line) => tier(line.confidence) === 1), [transcript])

  const linesRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [correcting, setCorrecting] = useState<LineSelection | null>(null)
  const [rewriting, setRewriting] = useState<string | null>(null)
  // The line that holds the list's one tab stop; the first line until the user moves.
  const [active, setActive] = useState<string | null>(null)
  const keyboardMenuAt = useRef(0)
  const hintId = useId()
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript

  // The toolbar follows the selection inside the transcript's lines.
  useEffect(() => {
    const onChange = (): void => {
      setSelection(readSelection(linesRef.current, transcriptRef.current))
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [])

  const focusLine = useCallback((id: string | undefined): void => {
    if (!id) return
    setActive(id)
    rowOf(linesRef.current, id)?.focus()
  }, [])

  /**
   * After an edit: drop the selection and keep focus here, so Ctrl+Z undoes it (on the line
   * itself when we know it, so the arrow keys carry on from there).
   */
  const settle = useCallback((id?: string) => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    const row = id ? rowOf(linesRef.current, id) : null
    if (row && id) {
      setActive(id)
      row.focus({ preventScroll: true })
    } else {
      linesRef.current?.focus({ preventScroll: true })
    }
  }, [])

  const actions: Actions = {
    setEdits: (id, next) => {
      onEditOverlay(id, next)
      settle(id)
    },
    rewrite: (id) => {
      settle()
      setRewriting(id)
    },
    quote: (line, text) => {
      onQuote(line, text)
      settle(line.id)
      notify('Added to your notes')
    },
    copy: (text) => {
      window.api.copyText(text)
      settle()
      notify('Copied')
    },
    listen: (line) => {
      listenToLine(pageId, line)
    },
    speaker: (line, anchor) => {
      if (!line.cluster) return
      setSplit(null)
      setPicker({ speaker: line.cluster, line: line.id, anchor })
    }
  }

  /** Opens a line's menu: at the pointer for a right-click, under the line's words for keys. */
  const openLineMenu = (id: string, target: Element, point: { x: number; y: number } | null): void => {
    const picked = readSelection(linesRef.current, transcript)
    const inLine = picked?.line === id ? picked : null
    const anchor = (rowOf(linesRef.current, id)?.querySelector('[data-line]') ?? target).getBoundingClientRect()
    setMenu({
      line: id,
      span: inLine?.span ?? null,
      edit: point ? (inLine ? null : editAt(target)) : null,
      rect: inLine?.rect ?? null,
      x: point?.x ?? anchor.left + 8,
      y: point?.y ?? anchor.bottom
    })
  }

  const onContextMenu = (event: ReactMouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const id = event.target.closest<HTMLElement>('[data-row]')?.dataset.row
    if (!id || rewriting === id) return
    event.preventDefault()
    // Already opened from the keydown (Shift+F10 or the menu key); this is the same press.
    if (Date.now() - keyboardMenuAt.current < KEYBOARD_MENU_MS) return
    // The context-menu key reports (0, 0) on some platforms; anchor to the line instead.
    const fromKeys = event.clientX === 0 && event.clientY === 0
    openLineMenu(id, event.target, fromKeys ? null : { x: event.clientX, y: event.clientY })
  }

  const onLinesKeyDown = (event: ReactKeyboardEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return
    const lines = transcriptRef.current
    if (target === linesRef.current) {
      // Focus was parked on the list after an edit: the arrow keys pick the lines up again.
      if (rovingIndex(event.key, -1, lines.length) === null) return
      event.preventDefault()
      focusLine(lines.find((line) => line.id === active)?.id ?? lines[0]?.id)
      return
    }
    const row = target.closest<HTMLElement>('[data-row]')
    const id = row?.dataset.row
    if (!row || !id || rewriting === id) return
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault()
      keyboardMenuAt.current = Date.now()
      openLineMenu(id, row, null)
      return
    }
    if (target !== row) return
    if (event.key === 'Enter') {
      event.preventDefault()
      actions.rewrite(id)
      return
    }
    const index = lines.findIndex((line) => line.id === id)
    const next = rovingIndex(event.key, index, lines.length)
    if (next === null) return
    event.preventDefault()
    focusLine(lines[next]?.id)
  }

  // Lines read the parent's current props through this, so their handlers never change.
  const live = useRef({ pageId, onEditLine })
  live.current = { pageId, onEditLine }
  const handlers = useMemo(
    (): LineHandlers => ({
      openPicker: (speaker, line, target) => {
        setSplit(null)
        setPicker({ speaker, line, anchor: target.getBoundingClientRect() })
      },
      listen: (line) => {
        listenToLine(live.current.pageId, line)
      },
      save: (id, text) => {
        live.current.onEditLine(id, text)
      },
      doneRewriting: (id) => {
        setRewriting(null)
        setActive(id)
        // After the textarea is gone, so focus lands on the line rather than nowhere.
        requestAnimationFrame(() => {
          const row = rowOf(linesRef.current, id) ?? linesRef.current
          row?.focus({ preventScroll: true })
        })
      },
      focused: setActive
    }),
    []
  )

  const lineById = (id: string): TranscriptSegment | undefined =>
    transcript.find((entry) => entry.id === id)
  const selectedLine = selection ? lineById(selection.line) : undefined
  const menuLine = menu ? lineById(menu.line) : undefined
  const correctingLine = correcting ? lineById(correcting.line) : undefined
  const tabStop = (active !== null && lineById(active) ? active : null) ?? transcript[0]?.id

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
    <section className="transcript" aria-label="Transcript">
      <div className={showSpeakersBar ? 'speakers-bar' : 'speakers-bar status-only'}>
        {/* The avatar chips say what they are; only the unlabeled live state needs a word. */}
        {labeled ? null : <span className="speakers-label">Live</span>}
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
          {/* Always present, so screen readers hear the status as it appears and changes. */}
          <span className="meeting-status-live" aria-live="polite">
            {status && status.state !== 'done' ? (
              <span
                className={
                  status.state === 'error'
                    ? 'meeting-status is-error'
                    : statusBusy(status)
                      ? 'meeting-status is-busy'
                      : 'meeting-status'
                }
                {...(status.task === 'speakers' && statusBusy(status)
                  ? tip('Speaker names and line breaks may still change until this finishes')
                  : {})}
              >
                {statusBusy(status) ? <span className="meeting-status-spinner" aria-hidden="true" /> : null}
                {statusLabel(status)}
              </span>
            ) : null}
          </span>
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
            <SummaryButton pageId={pageId} hasSummary={hasSummary} className="btn ghost" />
          ) : null}
        </span>
      </div>

      <div
        className="lines"
        ref={linesRef}
        tabIndex={-1}
        onContextMenu={onContextMenu}
        onKeyDown={onLinesKeyDown}
      >
        {transcript.map((line, index) => (
          <TranscriptLine
            key={line.id}
            line={line}
            speaker={line.cluster ? byId.get(line.cluster) : undefined}
            continues={index > 0 && transcript[index - 1]?.cluster === line.cluster}
            picked={picker?.line === line.id}
            playing={nowPlaying === line.id}
            rewriting={rewriting === line.id}
            tabbable={tabStop === line.id}
            hint={hintId}
            handlers={handlers}
          />
        ))}
        <span id={hintId} hidden>
          Arrow keys move between lines, Enter edits the line, Shift+F10 shows more actions.
        </span>
        {transcribing !== null ? <PendingLine pending={transcribing} /> : null}
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
              settle(correctingLine.id)
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
              const blank = unusedSpeakerName(speakers.map((speaker) => speaker.name))
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

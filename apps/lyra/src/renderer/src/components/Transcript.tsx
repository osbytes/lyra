import {
  Fragment,
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
import { expandToEdits, visibleText, type Span, type TranscriptEdit } from '../../../shared/transcriptOverlay'
import type { NewSpeaker } from '../hooks/usePages'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { rovingIndex } from '../lib/focus'
import { clockLabel as clock } from '../lib/format'
import { log } from '../lib/log'
import { unusedSpeakerName } from '../lib/status'
import { notify } from '../lib/toast'
import { useContextMenu } from './ContextMenu'
import { pausePlayback, play, playbackState, resumePlayback, stopPlayback, usePlayback } from '../lib/playback'
import { scrollBehavior } from '../lib/motion'
import { speakerSlot } from '../lib/speakerTone'
import { cn } from '../lib/utils'
import { Floating, ScrollArea, Segmented } from './Controls'
import {
  CloseIcon,
  CopyIcon,
  NoteIcon,
  ErrorIcon,
  LowConfidenceIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  WarningIcon
} from './Icons'
import { SpeakerBadge, SpeakerName } from './SpeakerBadge'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { LiveDot } from './ui/status'
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
import { Button } from './ui/button'

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
  /** Gives some of a line's words to a speaker, splitting the line around them. */
  onSplitLine: (id: string, span: Span, speaker: string | NewSpeaker) => string | null
  /** Names a speaker in the document (after main has worked out who it is). */
  onName: (id: string, name: string, personId: string | null) => void
  onUndo: () => void
  /** False in the side-panel layout, where speakers are listed in the panel instead. */
  showSpeakersBar: boolean
  /** Opens the picker from outside (the side panel); a new object each time. */
  pickerRequest: { speaker: string; anchor: DOMRect } | null
  /** The summary's sections by the id of each one's first line: a sticky heading goes above it. */
  sectionAt?: ReadonlyMap<string, { start: number; title: string; summary: string }>
  /** Puts a reference to a line (a section's first line) in the notes, as a chip. */
  onReference?: (label: string, lineId: string) => void
  /** While recording into the transcript: whether speech is being transcribed (null when not). */
  transcribing: Pending | null
}

/** `span`: only these words of the line (a range of its original), not all of it. */
type Picker = { speaker: string; line: string | null; span?: Span; anchor: DOMRect }

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
    <div className={cn(LINE_GRID, 'line pending-line')} role="status" aria-live="polite">
      <span />
      <span className="flex justify-center pt-[9px]">
        <LiveDot />
      </span>
      <span className="col-start-3 text-[12.5px] leading-[18px]">
        <SpeakerName name={`${label}…`} slot={0} certainty="unknown" />
      </span>
      <p className="col-start-3 m-0 text-text-3 italic">
        <span className={`pending-dots${working ? ' is-working' : ''}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </p>
    </div>
  )
}

// --- Small helpers ------------------------------------------------------------------

/** A line's grid: time, gutter (play, confidence, live), speaker over text, marks. */
const LINE_GRID =
  'grid scroll-mt-10 grid-cols-[62px_26px_minmax(0,1fr)_auto] gap-x-2 rounded-sm px-2.5 py-1.5 text-transcript relative @max-md:grid-cols-[44px_0_minmax(0,1fr)_auto] @max-md:gap-x-1.5'

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

const AUDIO_GONE = 'This session’s audio is no longer kept.'

/** Plays the session from a line on, through to the end, following the words. */
function playFromLine(pageId: string, line: TranscriptSegment, lines: readonly TranscriptSegment[]): void {
  play({ pageId, from: line.start, end: lines.at(-1)?.end ?? line.end, lines }).then(
    (ok) => {
      if (!ok) notify(AUDIO_GONE)
    },
    (error: unknown) => {
      log('transcript', 'could not play a line', String(error))
      notify('Couldn’t play from this line.')
    }
  )
}

/** The key playing in this session (a line id, or 'picker'), or null. */
function usePlayingKey(pageId: string): string | null {
  const state = usePlayback()
  return state?.pageId === pageId ? state.key : null
}

// --- Speaker picker --------------------------------------------------------------------

type Option =
  | { kind: 'person'; person: Person; score: number | null }
  | { kind: 'new'; name: string }
  | { kind: 'speaker'; speaker: SpeakerEntry }
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
  onSplitLine,
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
  onSplitLine: Props['onSplitLine']
  onName: Props['onName']
  onSplit: () => void
}) {
  const [query, setQuery] = useState('')
  const nowPlaying = usePlayingKey(pageId)
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
  // Some of the line's words: always just those, never the speaker's other lines.
  const words =
    line && picker.span
      ? visibleText(line.original, line.edits, expandToEdits(line.edits, picker.span))
      : null
  const justLine = scope === 'line' && !!line
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
    // A line or some of its words can go to a speaker already here who isn't a saved voice.
    const here: Option[] = justLine
      ? allSpeakers
          .filter((entry) => entry.id !== speaker.id && !entry.personId)
          .filter((entry) => entry.name.toLowerCase().includes(needle))
          .map((entry) => ({ kind: 'speaker' as const, speaker: entry }))
      : []
    const out: Option[] = [...here, ...ranked]
    const exact =
      people.some((person) => person.name.toLowerCase() === needle) ||
      here.some((option) => option.kind === 'speaker' && option.speaker.name.toLowerCase() === needle)
    if (needle && !exact) out.push({ kind: 'new', name: query.trim() })
    out.push({ kind: 'keep' })
    return out
  }, [allSpeakers, justLine, people, query, speaker.id, speaker.matches])

  const run = async (option: Option | undefined): Promise<void> => {
    if (!option) return
    setError(null)
    try {
      if (option.kind === 'keep') {
        onClose()
        return
      }
      if (justLine) {
        // Just this line: move it to whoever that is, reusing their speaker if present.
        const personId = option.kind === 'person' ? option.person.id : null
        const name =
          option.kind === 'person' ? option.person.name : option.kind === 'speaker' ? option.speaker.name : option.name
        const existing =
          option.kind === 'speaker'
            ? option.speaker
            : allSpeakers.find((entry) =>
                personId ? entry.personId === personId : entry.name.toLowerCase() === name.toLowerCase()
              )
        const target = existing ? existing.id : { name, personId, confirmed: true }
        if (picker.span) {
          onSplitLine(line.id, picker.span, target)
          onClose()
          return
        }
        const created = onAssign([line.id], target)
        onClose()
        const to = existing?.id ?? created
        if (to) offerSimilarLines(pageId, line.id, speaker.id, to, name, onAssign)
        return
      }
      if (option.kind === 'speaker') {
        onAssign(own.map((entry) => entry.id), option.speaker.id)
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
    words !== null
      ? `Who said “${words.length > 32 ? `${words.slice(0, 31).trimEnd()}…` : words}”?`
      : justLine
      ? 'Who said this?'
      : state === 'likely' && matched
        ? `Is this ${matched.name}?`
        : state === 'unknown'
          ? `Who is ${speaker.name}?`
          : speaker.name
  const sample = line ?? own[0]
  const top = Math.min(picker.anchor.bottom + 8, window.innerHeight - 420)
  const left = Math.min(picker.anchor.left, window.innerWidth - 356)

  const active = options[highlight]
  const count = justLine ? 1 : own.length
  const sampleButton = sample ? (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-pressed={nowPlaying === 'picker'}
      aria-label={nowPlaying === 'picker' ? 'Stop the sample' : 'Play a sample'}
      {...tip(nowPlaying === 'picker' ? 'Stop' : 'Play a sample')}
      onClick={() => {
        if (nowPlaying === 'picker') {
          stopPlayback()
          return
        }
        play({ pageId, from: sample.start, end: Math.min(sample.end, sample.start + 8), key: 'picker' }).then(
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
    </Button>
  ) : null

  return (
    <div className="picker-layer" onMouseDown={onClose}>
      <ScrollArea
        ref={dialog}
        className={cn('picker fixed z-[100] flex max-h-[calc(100vh-16px)] flex-col overflow-y-auto rounded-lg border-(length:--border-width) border-border bg-popover p-2.5 text-body-sm text-popover-foreground shadow-md', 'w-[320px]')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ top: Math.max(8, top), left: Math.max(8, left) }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={onKeyDown}
      >
        <div className="mb-2 flex items-center gap-2">
          <div className="grid min-w-0 flex-1">
            <b className="truncate text-body-sm font-semibold">{title}</b>
            <small className="text-label text-text-3">
              {justLine
                ? `${clock(line.start)}${line.confidence === null ? '' : ` · ${percent(line.confidence)} like ${speaker.name}`}`
                : `${String(own.length)} ${own.length === 1 ? 'line' : 'lines'}${speaker.confidence === null ? '' : ` · ${percent(speaker.confidence)} voice match`}`}
            </small>
          </div>
          {sampleButton}
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </Button>
        </div>

        {line && own.length > 1 && !picker.span ? (
          <Segmented
            className="picker-scope mb-2 flex w-full [&>button]:flex-1"
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
          <div
            className="picker-hint mb-2 flex items-center gap-2 rounded-sm border-(length:--border-width) border-warning/40 bg-warning-soft px-2.5 py-2 text-label text-foreground"
            role="note"
          >
            <WarningIcon className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1">
              <b>
                {odd.length} of {own.length} lines
              </b>{' '}
              sound like someone else.
            </span>
            <Button size="sm" onClick={onSplit}>
              Split…
            </Button>
          </div>
        ) : null}

        {scope === 'all' && state === 'likely' && matched ? (
          <div className="picker-confirm mb-2 flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => void run({ kind: 'person', person: matched, score: speaker.confidence })}
            >
              Yes, it’s {matched.name}
            </Button>
            <Button onClick={() => input.current?.focus()}>Someone else</Button>
          </div>
        ) : null}

        <input
          ref={input}
          data-autofocus
          type="text"
          className="mb-1.5 h-8 w-full min-w-0 rounded-sm border-(length:--border-width) border-input bg-card px-2.5 text-body text-foreground placeholder:text-text-3 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          value={query}
          placeholder={state === 'likely' ? 'Or type someone else…' : 'Type a name'}
          aria-label="Name"
          role="combobox"
          aria-expanded="true"
          aria-controls="picker-options"
          aria-activedescendant={`picker-option-${String(highlight)}`}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlight(0)
          }}
        />

        <div className={'px-2 pt-1.5 pb-0.5 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase'}>{speaker.matches.length ? 'Sounds like' : 'Saved voices'}</div>
        <ul className="m-0 list-none p-0" id="picker-options" role="listbox" aria-label="People">
          {options.map((option, index) => (
            <li
              key={option.kind === 'person' ? option.person.id : option.kind === 'speaker' ? `s:${option.speaker.id}` : option.kind}
              id={`picker-option-${String(index)}`}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                'flex h-[30px] cursor-default items-center gap-2 rounded-sm px-2',
                index === highlight && 'bg-brand-soft text-brand-text hc:outline-2 hc:outline-ring'
              )}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void run(option)}
            >
              {option.kind === 'person' ? (
                <>
                  <SpeakerBadge name={option.person.name} slot={speakerSlot(people, option.person.id)} />
                  <span className="min-w-0 flex-1 truncate">
                    {option.person.name}
                    {option.person.self ? ' (you)' : ''}
                  </span>
                  <MatchStrength score={option.score} />
                </>
              ) : option.kind === 'speaker' ? (
                <>
                  <SpeakerBadge name={option.speaker.name} slot={speakerSlot(allSpeakers, option.speaker.id)} />
                  <span className="min-w-0 flex-1 truncate">{option.speaker.name}</span>
                </>
              ) : option.kind === 'new' ? (
                <>
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate">New person “{option.name}”</span>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate text-text-2">Leave as “{speaker.name}”</span>
              )}
            </li>
          ))}
        </ul>

        {error ? (
          <p className="picker-error m-0 mt-1.5 flex items-start gap-1.5 px-2 text-label text-destructive" role="alert">
            <ErrorIcon className="mt-px shrink-0" />
            {error}
          </p>
        ) : null}

        {scope === 'all' ? (
          <>
            <div className="mx-0.5 my-1.5 h-px bg-border" />
            <label className="flex items-center gap-2 px-2 py-1 text-[12.5px]">
              <Checkbox checked={remember} onCheckedChange={(next) => setRemember(next === true)} />
              Remember this voice for future sessions
            </label>
            <p className="m-0 px-2 pb-1 text-label text-text-3">
              Saves a voiceprint on this computer only. You can delete it in Saved voices.
            </p>
          </>
        ) : null}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          {own.length > 1 && !(scope === 'all' && odd.length > 0 && odd.length < own.length) ? (
            <Button size="sm" variant="ghost" onClick={onSplit}>
              Two people here? Split
            </Button>
          ) : (
            <span />
          )}
          {active && active.kind !== 'keep' ? (
            <Button size="sm" variant="primary" onClick={() => void run(active)}>
              {words !== null ? 'Move these words' : justLine ? 'Move this line' : `Name ${String(count)} ${count === 1 ? 'line' : 'lines'}`}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

/** How well a saved voice matches, in plain words rather than a percentage. */
function MatchStrength({ score }: { score: number | null }) {
  if (score === null) return null
  if (score >= SURE_MATCH) return <Badge tone="success" className="h-[18px]">Strong match</Badge>
  if (score >= LOW_CONFIDENCE) return <span className="text-label text-text-3">Possible</span>
  return <span className="text-label text-text-3">Unlikely</span>
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

  const least = own[0]?.id
  return (
    <div className="picker-layer" onMouseDown={onCancel}>
      <ScrollArea
        ref={dialog}
        className={cn('picker fixed z-[100] flex max-h-[calc(100vh-16px)] flex-col overflow-y-auto rounded-lg border-(length:--border-width) border-border bg-popover p-2.5 text-body-sm text-popover-foreground shadow-md', 'split w-[520px] max-w-[calc(100vw-16px)]')}
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
        <div className="flex items-baseline justify-between gap-2 px-1">
          <b className="text-body-sm font-semibold">Split {speaker.name}</b>
          <span className="text-label text-text-3">Tick the lines someone else said</span>
        </div>
        <ScrollArea as="ul" className="split-list m-0 mt-2 grid max-h-[320px] list-none gap-0.5 p-0" aria-multiselectable="true">
          {own.map((line) => (
            <li key={line.id}>
              <label
                className={cn(
                  'flex items-start gap-2 rounded-xs p-1 text-body-sm',
                  picked.has(line.id) && 'bg-brand-soft'
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={picked.has(line.id)}
                  onCheckedChange={() => {
                    setPicked((current) => {
                      const next = new Set(current)
                      if (next.has(line.id)) next.delete(line.id)
                      else next.add(line.id)
                      return next
                    })
                  }}
                />
                <span className="shrink-0 font-mono text-[11.5px] leading-5 text-text-3">{clock(line.start)}</span>
                <span className="min-w-0 flex-1">{line.text}</span>
                {line.id === least && line.confidence !== null && line.confidence < LOW_CONFIDENCE ? (
                  <Badge tone="warning" className="h-[18px]">
                    Least alike
                  </Badge>
                ) : null}
              </label>
            </li>
          ))}
        </ScrollArea>
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <span className="text-label text-text-3">
            {picked.size
              ? `${String(picked.size)} of ${String(own.length)} lines will become a new speaker you can name next`
              : 'Nothing ticked'}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!valid} onClick={() => onSplit([...picked])}>
              Split {picked.size} {picked.size === 1 ? 'line' : 'lines'}
            </Button>
          </span>
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
  /** Pauses or resumes the stream playing through this session. */
  togglePause: () => void
  save: (id: string, text: string) => void
  doneRewriting: (id: string) => void
  focused: (id: string) => void
}

type LineProps = {
  line: TranscriptSegment
  speaker: SpeakerEntry | undefined
  /** The speaker's palette slot in this session (badge hue and shape). */
  slotOf: (id: string) => number
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
  slotOf,
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
  const name = speaker?.name ?? 'Speaker'
  return (
    <div
      className={cn(
        LINE_GRID,
        'line group/line',
        continues && 'continues',
        level === 1 && 'low',
        picked && 'picked bg-selection',
        playing && 'playing bg-brand-soft shadow-[inset_3px_0_0_var(--accent)]'
      )}
      data-row={line.id}
      role="group"
      aria-labelledby={`${id}-label ${id}-text`}
      aria-describedby={hint}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => handlers.focused(line.id)}
    >
      <button
        type="button"
        className={cn(
          'line-play inline-flex h-6 items-start gap-1 rounded-xs pt-[3px] font-mono text-[11.5px] tabular-nums text-text-3',
          'hover:text-brand-text focus-visible:outline-2 focus-visible:outline-ring',
          playing && 'text-brand-text'
        )}
        aria-pressed={playing}
        aria-label={playing ? 'Pause or resume playback' : `Play from ${clock(line.start)}`}
        {...tip(playing ? 'Pause' : 'Play from here')}
        onClick={() => {
          if (playing) handlers.togglePause()
          else handlers.listen(line)
        }}
      >
        {clock(line.start)}
      </button>
      <span className="flex justify-center pt-1">
        {playing ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-xs text-brand-text hover:bg-accent"
            onClick={() => handlers.togglePause()}
          >
            <PauseIcon />
          </button>
        ) : level === 1 && line.cluster ? (
          <span
            role="img"
            className="text-suggested"
            aria-label="May be mislabeled"
            {...tip(line.confidence === null ? 'May be mislabeled' : `${percent(line.confidence)} voice match: may be mislabeled`)}
          >
            <LowConfidenceIcon />
          </span>
        ) : (
          // The time is the play control too; this is the bigger target beside it.
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-xs text-text-3 opacity-0 group-hover/line:opacity-100 hover:bg-accent hover:text-brand-text"
            onClick={() => handlers.listen(line)}
          >
            <PlayIcon />
          </button>
        )}
      </span>
      <span className={cn('who-row col-start-3 mb-px text-[12.5px] leading-[18px]', continues && 'hidden')}>
        {line.cluster ? (
          <button
            type="button"
            className="who rounded-xs focus-visible:outline-2 focus-visible:outline-ring"
            {...tip('Change who said this')}
            onClick={(event) => {
              if (line.cluster) handlers.openPicker(line.cluster, line.id, event.currentTarget)
            }}
          >
            <SpeakerName name={name} slot={slotOf(line.cluster)} certainty={state} />
          </button>
        ) : (
          <SpeakerName name="Labeling…" slot={0} certainty="unknown" />
        )}
      </span>
      <div className={cn('line-body col-start-3 min-w-0', level === 1 && 'is-unsure')}>
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
  onSplitLine,
  onName,
  onUndo,
  showSpeakersBar,
  pickerRequest,
  transcribing,
  sectionAt,
  onReference
}: Props) {
  const people = usePeople()
  const nowPlaying = usePlayingKey(pageId)
  // Leaving the session (or closing it) stops whatever is playing from it.
  useEffect(() => stopPlayback, [pageId])
  const [picker, setPicker] = useState<Picker | null>(null)
  const [split, setSplit] = useState<{ speaker: string; anchor: DOMRect } | null>(null)
  const byId = useMemo(() => new Map(speakers.map((speaker) => [speaker.id, speaker])), [speakers])
  // Stable for the memoized lines: a speaker keeps its slot for the life of the session.
  const slotOf = useCallback((id: string) => speakerSlot(speakers, id), [speakers])
  const labeled = useMemo(() => transcript.some((line) => line.cluster !== null), [transcript])
  const present = useMemo(() => {
    const heard = new Set<string>()
    for (const line of transcript) if (line.cluster !== null) heard.add(line.cluster)
    return speakers.filter((speaker) => heard.has(speaker.id))
  }, [speakers, transcript])
  const pending = useMemo(() => present.filter((speaker) => stateOf(speaker) !== 'sure'), [present])
  const unsure = useMemo(() => transcript.filter((line) => tier(line.confidence) === 1), [transcript])

  const linesRef = useRef<HTMLDivElement>(null)
  // Playback walks down the lines; when the next one goes just past the bottom of the view, the
  // view follows. Scrolled away to read something else, it's left alone.
  useEffect(() => {
    if (!nowPlaying || nowPlaying === 'picker') return
    const row = rowOf(linesRef.current, nowPlaying)
    const view = row?.closest<HTMLElement>('.scroller')
    if (!row || !view) return
    const box = view.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    if (at.bottom > box.bottom && at.top - box.bottom < 160) row.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() })
  }, [nowPlaying])
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
      playFromLine(pageId, line, transcript)
    },
    speaker: (line, anchor) => {
      if (!line.cluster) return
      setSplit(null)
      setPicker({ speaker: line.cluster, line: line.id, anchor })
    },
    attribute: (line, span, anchor) => {
      if (!line.cluster) return
      settle()
      setSplit(null)
      setPicker({ speaker: line.cluster, line: line.id, span, anchor })
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
  const live = useRef({ pageId, onEditLine, transcript })
  live.current = { pageId, onEditLine, transcript }
  const handlers = useMemo(
    (): LineHandlers => ({
      openPicker: (speaker, line, target) => {
        setSplit(null)
        setPicker({ speaker, line, anchor: target.getBoundingClientRect() })
      },
      listen: (line) => {
        playFromLine(live.current.pageId, line, live.current.transcript)
      },
      togglePause: () => {
        const state = playbackState()
        if (state?.paused) resumePlayback()
        else pausePlayback()
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

  /** A section's lines: from its first line up to the next section's. */
  const sectionLines = (first: TranscriptSegment): TranscriptSegment[] => {
    const from = transcript.indexOf(first)
    let to = transcript.length
    for (let index = from + 1; index < transcript.length; index++) {
      const id = transcript[index]?.id
      if (id && sectionAt?.has(id)) {
        to = index
        break
      }
    }
    return transcript.slice(from, to)
  }
  const sectionMenu = (
    event: ReactMouseEvent,
    first: TranscriptSegment,
    section: { start: number; title: string; summary: string }
  ): void => {
    const label = `§ ${section.title} · ${clock(section.start)}`
    speakerMenu.open(event, section.title, [
      {
        label: 'Reference in notes',
        icon: <NoteIcon />,
        disabled: !onReference,
        run: () => {
          onReference?.(label, first.id)
          notify('Added a reference to your notes')
        }
      },
      {
        label: 'Play this section',
        icon: <PlayIcon />,
        run: () => playFromLine(pageId, first, transcript)
      },
      'separator',
      {
        label: 'Copy section transcript',
        icon: <CopyIcon />,
        run: () => {
          const lines = sectionLines(first).map((line) => {
            const who = line.cluster ? (byId.get(line.cluster)?.name ?? 'Speaker') : 'Speaker'
            return `**${who}** (${clock(line.start)}): ${line.text}`
          })
          window.api.copyText(`## ${section.title}\n\n${lines.join('\n\n')}`)
          notify('Copied the section')
        }
      },
      {
        label: 'Copy section summary',
        icon: <CopyIcon />,
        disabled: !section.summary,
        run: () => {
          window.api.copyText(`${section.title}: ${section.summary}`)
          notify('Copied the section summary')
        }
      }
    ])
  }

  return (
    <section className="transcript" aria-label="Transcript">
      {/* In the panel layout the speakers live in the panel. */}
      {showSpeakersBar ? (
        <div className="speakers-bar flex flex-wrap items-center gap-1.5">
          {/* The avatar chips say what they are; only the unlabeled live state needs a word. */}
          {labeled ? null : <span className="speakers-label">Live</span>}
          {present.map((speaker) => (
            <button
              key={speaker.id}
              type="button"
              className={cn(
                'speaker-chip inline-flex h-7 max-w-full items-center rounded-full border-(length:--border-width) border-border bg-card pr-2.5 pl-1',
                'hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring'
              )}
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
              <SpeakerName name={speaker.name} slot={slotOf(speaker.id)} certainty={stateOf(speaker)} />
            </button>
          ))}
          <span className="speakers-tools ml-auto flex items-center gap-1.5">
            {pending.length ? (
              <button
                type="button"
                className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-warning-soft px-2 text-[11.5px] font-medium text-warning hover:brightness-95 hc:border hc:border-current"
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
                className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-warning-soft px-2 text-[11.5px] font-medium text-warning hover:brightness-95 hc:border hc:border-current"
                {...tip('Lines whose voice doesn’t match their speaker well')}
                onClick={(event) => {
                  const first = unsure[0]
                  if (first?.cluster) openPicker(first.cluster, first.id, event.currentTarget)
                }}
              >
                {unsure.length} unsure {unsure.length === 1 ? 'line' : 'lines'}
              </button>
            ) : null}
            {/* Once there is a summary, rewriting it is offered on the summary itself. */}
            {notesEngine !== 'off' && labeled && !hasSummary ? (
              <SummaryButton pageId={pageId} hasSummary={hasSummary} />
            ) : null}
          </span>
        </div>
      ) : null}

      <div
        className="lines"
        ref={linesRef}
        tabIndex={-1}
        onContextMenu={onContextMenu}
        onKeyDown={onLinesKeyDown}
      >
        {transcript.map((line, index) => {
          const section = sectionAt?.get(line.id)
          return (
          <Fragment key={line.id}>
          {section ? (
            // Sticks to the top of the transcript while its section is on screen; the next
            // section's heading takes its place.
            <h3
              className="section-heading sticky top-0 z-[2] m-0 -mx-2 flex cursor-context-menu items-baseline gap-2.5 border-b border-border bg-background/95 px-4 py-1.5 text-body-sm font-semibold backdrop-blur-[2px]"
              data-section-start={section.start}
              onContextMenu={(event) => sectionMenu(event, line, section)}
            >
              <span className="font-mono text-label font-medium text-brand-text">{clock(section.start)}</span>
              <span className="min-w-0 truncate">{section.title}</span>
            </h3>
          ) : null}
          <TranscriptLine
            line={line}
            speaker={line.cluster ? byId.get(line.cluster) : undefined}
            slotOf={slotOf}
            continues={index > 0 && transcript[index - 1]?.cluster === line.cluster}
            picked={picker?.line === line.id}
            playing={nowPlaying === line.id}
            rewriting={rewriting === line.id}
            tabbable={tabStop === line.id}
            hint={hintId}
            handlers={handlers}
          />
          </Fragment>
          )
        })}
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
            key={`${picker.speaker}:${picker.line ?? ''}:${picker.span ? `${String(picker.span.start)}-${String(picker.span.end)}` : ''}`}
            pageId={pageId}
            picker={picker}
            speaker={pickedSpeaker}
            allSpeakers={speakers}
            lines={transcript}
            people={people}
            onClose={() => setPicker(null)}
            onAssign={onAssign}
            onSplitLine={onSplitLine}
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

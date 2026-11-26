import * as Y from 'yjs'
import { appendTranscript } from './transcriptText'
import {
  applyOverlay,
  hasTextEdits,
  readEdits,
  rewriteLine,
  type TranscriptEdit
} from './transcriptOverlay'

/**
 * The editable layer of a session, as a Yjs document. Main owns the copy on disk; each window
 * holds a replica kept in sync over IPC. See docs/SESSION-MODEL.md.
 *
 * Shape:
 *   title: Y.Text
 *   summary: Y.Text                  generated meeting notes (summary, decisions, actions)
 *   notes: Y.Text                    the user's own writing; dictation lands here
 *   meta: Y.Map { tags: Y.Array<string>, speakers: Y.Map<id, Y.Map> }
 *     speaker: { name, personId, confirmed, confidence, matches: { personId, score }[] }
 *   transcript: Y.Array<Y.Map>       one entry per segment, in time order
 *     segment: { id, rawId, start, end, cluster, userCluster, text: Y.Text, original, edits, edited,
 *                confidence }
 *       `original` is what the model heard and is never edited; `edits` are the user's
 *       corrections, removals and highlights over it (transcriptOverlay.ts); `text` is the
 *       result, kept in the document so exports and readers needn't apply the overlay.
 *       `userCluster` is true once the user chose the line's speaker; later passes keep it.
 */

/** Who made a change. Lets undo skip machine writes and lets main skip echoing a window. */
export const ORIGIN_USER = 'user'
export const ORIGIN_REMOTE = 'remote'
/** Live transcription: its own author, never undone by the user's Ctrl+Z. */
export const ORIGIN_TRANSCRIBER = 'transcriber'

/** Below this, a line's voice doesn't sound much like the rest of its speaker. */
export const LOW_CONFIDENCE = 0.6
/** A speaker matched at least this well to a saved voice is shown as a sure match. */
export const SURE_MATCH = 0.85

/** A segment's mark that the user chose its speaker (`TranscriptSegment.userCluster`). */
const USER_CLUSTER = 'userCluster'

export type SpeakerMatch = { personId: string; score: number }

export type SpeakerEntry = {
  id: string
  name: string
  personId: string | null
  /** The user named or confirmed this speaker; otherwise it is Lyra's guess. */
  confirmed: boolean
  /** Voice match for `personId`, 0–1; null when no saved voice matched. */
  confidence: number | null
  /** Saved voices ranked by how well they match, best first. */
  matches: SpeakerMatch[]
}

export type TranscriptSegment = {
  id: string
  rawId: string | null
  start: number
  end: number
  cluster: string | null
  /**
   * The user chose this line's speaker (moved it, or merged its speaker into another). A new
   * pass keeps their choice; without this a move on a live line, which has no raw pass to
   * compare against, would be undone by the next relabel.
   */
  userCluster: boolean
  text: string
  /** What the model heard, before any edit. Locked: edits overlay it, never change it. */
  original: string
  /** The user's corrections, removals and highlights, as ranges of `original`. */
  edits: TranscriptEdit[]
  /** Some of the words differ from `original` (a highlight alone isn't an edit). */
  edited: boolean
  /** How much this line's voice sounds like the rest of its speaker, 0–1; null if unknown. */
  confidence: number | null
}

export type SessionSnapshot = {
  title: string
  summary: string
  notes: string
  tags: string[]
  speakers: SpeakerEntry[]
  transcript: TranscriptSegment[]
}

export const docTitle = (doc: Y.Doc): Y.Text => doc.getText('title')
export const docSummary = (doc: Y.Doc): Y.Text => doc.getText('summary')
export const docNotes = (doc: Y.Doc): Y.Text => doc.getText('notes')
export const docMeta = (doc: Y.Doc): Y.Map<unknown> => doc.getMap('meta')
export const docTranscript = (doc: Y.Doc): Y.Array<Y.Map<unknown>> => doc.getArray('transcript')

function tagsOf(doc: Y.Doc): Y.Array<string> | null {
  const tags = docMeta(doc).get('tags')
  return tags instanceof Y.Array ? (tags as Y.Array<string>) : null
}

/** The speakers map; created by main when a document is made, so replicas never race on it. */
export function speakersOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> | null {
  const speakers = docMeta(doc).get('speakers')
  return speakers instanceof Y.Map ? (speakers as Y.Map<Y.Map<unknown>>) : null
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function readMatches(value: unknown): SpeakerMatch[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const { personId, score } = item as Record<string, unknown>
    return typeof personId === 'string' && typeof score === 'number' ? [{ personId, score }] : []
  })
}

export function readSpeaker(id: string, entry: Y.Map<unknown>): SpeakerEntry {
  const personId = entry.get('personId')
  return {
    id,
    name: str(entry.get('name'), id),
    personId: typeof personId === 'string' ? personId : null,
    confirmed: entry.get('confirmed') === true,
    confidence: numOrNull(entry.get('confidence')),
    matches: readMatches(entry.get('matches'))
  }
}

function readSpeakers(doc: Y.Doc): SpeakerEntry[] {
  const out: SpeakerEntry[] = []
  speakersOf(doc)?.forEach((value, id) => {
    if (value instanceof Y.Map) out.push(readSpeaker(id, value))
  })
  return out
}

export function readSegment(entry: Y.Map<unknown>): TranscriptSegment {
  const text = entry.get('text')
  const rawId = entry.get('rawId')
  const cluster = entry.get('cluster')
  const current = text instanceof Y.Text ? text.toJSON() : ''
  const original = str(entry.get('original'), current)
  const edited = entry.get('edited') === true
  const stored = readEdits(entry.get('edits'), original.length)
  // Lines edited before the overlay existed were typed over directly: read the change as one
  // correction, so they draw the same way.
  const edits = !stored.length && edited && current !== original ? rewriteLine(original, [], current) : stored
  return {
    id: str(entry.get('id')),
    rawId: typeof rawId === 'string' ? rawId : null,
    start: num(entry.get('start')),
    end: num(entry.get('end')),
    cluster: typeof cluster === 'string' ? cluster : null,
    userCluster: entry.get(USER_CLUSTER) === true,
    text: current,
    original,
    edits,
    edited,
    confidence: numOrNull(entry.get('confidence'))
  }
}

export function snapshotOf(doc: Y.Doc): SessionSnapshot {
  return {
    title: docTitle(doc).toJSON(),
    summary: docSummary(doc).toJSON(),
    notes: docNotes(doc).toJSON(),
    tags: tagsOf(doc)?.toArray().filter((tag): tag is string => typeof tag === 'string') ?? [],
    speakers: readSpeakers(doc),
    transcript: docTranscript(doc).toArray().map(readSegment)
  }
}

/**
 * Turns `text` into `next` with one delete and one insert around the changed middle. A
 * textarea change is almost always a single contiguous edit (typing, paste, dictation append),
 * so this keeps concurrent edits elsewhere in the text intact.
 */
export function applyTextChange(text: Y.Text, next: string): void {
  const current = text.toJSON()
  if (current === next) return
  let start = 0
  const max = Math.min(current.length, next.length)
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++
  let endCurrent = current.length
  let endNext = next.length
  while (
    endCurrent > start &&
    endNext > start &&
    current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)
  ) {
    endCurrent--
    endNext--
  }
  // Keep surrogate pairs whole, so a concurrent edit never sees half an emoji.
  if (start > 0 && isLowSurrogate(current.charCodeAt(start))) start--
  if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
    endCurrent++
    endNext++
  }
  if (endCurrent > start) text.delete(start, endCurrent - start)
  const inserted = next.slice(start, endNext)
  if (inserted) text.insert(start, inserted)
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Sets title, summary and/or notes in one transaction. */
export function editDoc(
  doc: Y.Doc,
  changes: { title?: string | undefined; summary?: string | undefined; notes?: string | undefined },
  origin: unknown
): void {
  doc.transact(() => {
    if (changes.title !== undefined) applyTextChange(docTitle(doc), changes.title)
    if (changes.summary !== undefined) applyTextChange(docSummary(doc), changes.summary)
    if (changes.notes !== undefined) applyTextChange(docNotes(doc), changes.notes)
  }, origin)
}

/** A new document with the given title and notes, and empty tags, speakers and transcript. */
export function initDoc(
  doc: Y.Doc,
  init: { title: string; notes: string; summary?: string },
  origin: unknown
): void {
  doc.transact(() => {
    const meta = docMeta(doc)
    if (!(meta.get('tags') instanceof Y.Array)) meta.set('tags', new Y.Array<string>())
    if (!(meta.get('speakers') instanceof Y.Map)) meta.set('speakers', new Y.Map())
    applyTextChange(docTitle(doc), init.title)
    applyTextChange(docNotes(doc), init.notes)
    if (init.summary) applyTextChange(docSummary(doc), init.summary)
  }, origin)
}

// --- Transcript edits ---------------------------------------------------------------

/**
 * A line written by a pass. `userCluster` is for a pass that kept the user's choice of speaker
 * for these words (relabel's pinned words), so the next pass keeps it too.
 */
export type NewSegment = Omit<
  TranscriptSegment,
  'text' | 'original' | 'edits' | 'edited' | 'userCluster'
> & {
  text: string
  userCluster?: boolean
}

/** `keep`: the old line over the same audio whose text and/or chosen speaker the new one keeps. */
function segmentMap(
  segment: NewSegment,
  keep?: { text?: TranscriptSegment | undefined; cluster?: string | undefined }
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>()
  const text = keep?.text
  entry.set('id', segment.id)
  entry.set('rawId', segment.rawId)
  entry.set('start', segment.start)
  entry.set('end', segment.end)
  entry.set('cluster', keep?.cluster ?? segment.cluster)
  if (keep?.cluster !== undefined || segment.userCluster === true) entry.set(USER_CLUSTER, true)
  entry.set('confidence', segment.confidence)
  // A kept line keeps the words its edits were made over, so they still line up.
  entry.set('original', text ? text.original : segment.text)
  entry.set('edits', text ? text.edits : [])
  entry.set('text', new Y.Text(text ? text.text : segment.text))
  entry.set('edited', text?.edited === true)
  return entry
}

const hasEdits = (segment: TranscriptSegment): boolean => segment.edited || segment.edits.length > 0

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** Whether a pass's line is the one already in the transcript, down to its words and speaker. */
function unchanged(old: TranscriptSegment, segment: NewSegment): boolean {
  return (
    old.id === segment.id &&
    old.rawId === segment.rawId &&
    old.start === segment.start &&
    old.end === segment.end &&
    old.cluster === segment.cluster &&
    old.userCluster === (segment.userCluster === true) &&
    old.confidence === segment.confidence &&
    old.original === segment.text
  )
}

/**
 * Replaces the transcript with a new pass. A line the user edited keeps their text, and a line
 * whose speaker the user chose keeps that speaker (while it still exists), when the new pass has
 * a line over the same stretch of audio, so re-labeling never undoes either.
 *
 * Lines at the start that the pass leaves exactly as they are stay in place: while recording the
 * speakers are settled again every half minute, mostly changing only the newest lines, and a
 * line that is rewritten loses the cursor of whoever is editing it.
 */
export function replaceTranscript(doc: Y.Doc, segments: NewSegment[], origin: unknown): void {
  doc.transact(() => {
    const transcript = docTranscript(doc)
    const speakers = speakersOf(doc)
    const existing = transcript.toArray().map(readSegment)
    let same = 0
    for (const segment of segments) {
      const old = existing[same]
      if (!old || !unchanged(old, segment)) break
      same++
    }
    const kept = existing.slice(same).filter((segment) => hasEdits(segment) || segment.userCluster)
    const used = new Set<string>()
    const entries = segments.slice(same).map((segment) => {
      const keep = kept
        .filter((old) => !used.has(old.id))
        .map((old) => ({ old, shared: overlap(old, segment) }))
        .filter(({ old, shared }) => shared > 0.5 * Math.min(old.end - old.start, segment.end - segment.start))
        .sort((a, b) => b.shared - a.shared)[0]?.old
      if (!keep) return segmentMap(segment)
      used.add(keep.id)
      const cluster =
        keep.userCluster && keep.cluster !== null && (!speakers || speakers.has(keep.cluster))
          ? keep.cluster
          : undefined
      return segmentMap(segment, { text: hasEdits(keep) ? keep : undefined, cluster })
    })
    if (transcript.length > same) transcript.delete(same, transcript.length - same)
    if (entries.length) transcript.insert(same, entries)
  }, origin)
}

// --- Live text ranges ---------------------------------------------------------------

/**
 * Live transcription writes into the notes. Each recording remembers where its text starts
 * (a position that moves with edits around it) and exactly what it inserted, so labeling can
 * take that text back out once it has produced a speaker-labeled transcript of the same audio.
 */
function liveRanges(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  const meta = docMeta(doc)
  let ranges = meta.get('liveRanges')
  if (!(ranges instanceof Y.Array)) {
    ranges = new Y.Array<Y.Map<unknown>>()
    meta.set('liveRanges', ranges)
  }
  return ranges as Y.Array<Y.Map<unknown>>
}

function readPosition(doc: Y.Doc, json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const position = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(json),
    doc
  )
  return position ? position.index : null
}

/**
 * A position that sticks to the character before `index`, so text typed after it (by the user)
 * never pushes it forward, and text inserted before it moves it along.
 */
function stickyPosition(text: Y.Text, index: number): unknown {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index, -1))
}

/**
 * Starts a new transcription range at the end of the notes. The transcriber is its own author:
 * it writes at its own cursor (this range's `cursor`), with its own origin, so the user can keep
 * typing anywhere and undo never takes back transcribed words.
 */
export function startTranscriber(doc: Y.Doc, origin: unknown, mode: LiveMode = 'notes'): void {
  const notes = docNotes(doc)
  doc.transact(() => {
    const range = new Y.Map<unknown>()
    const at = stickyPosition(notes, notes.length)
    range.set('start', at)
    range.set('cursor', at)
    range.set('text', '')
    range.set('mode', mode)
    liveRanges(doc).push([range])
  }, origin)
}

/**
 * Where the current recording's words go. New recordings always write transcript lines; `notes`
 * is how earlier versions wrote dictation into the notes. Null before the first recording.
 */
export type LiveMode = 'notes' | 'transcript'

export function liveModeOf(doc: Y.Doc): LiveMode | null {
  const range = currentRange(doc)
  if (!range) return null
  return range.get('mode') === 'transcript' ? 'transcript' : 'notes'
}

/** Removes one range's text from the notes if it is still exactly as transcribed. */
function removeRangeText(doc: Y.Doc, range: Y.Map<unknown>): boolean {
  const notes = docNotes(doc)
  const text = str(range.get('text'))
  const index = readPosition(doc, range.get('start'))
  if (!text || index === null || notes.toJSON().slice(index, index + text.length) !== text) return false
  notes.delete(index, text.length)
  // Tidy the blank lines a removal leaves at the end of the notes.
  const trimmed = notes.toJSON().replace(/\s+$/, '')
  if (trimmed.length < notes.length) notes.delete(trimmed.length, notes.length - trimmed.length)
  return true
}

/**
 * A live transcript line. Words from the same speaker within `joinGap` seconds of their last
 * line extend it (one line per turn, up to `maxLine` seconds), unless the user edited that line.
 * Text is joined with the dictation rules (spacing, capitals, voice commands) on one line.
 */
export function appendLiveSegment(
  doc: Y.Doc,
  segment: NewSegment,
  { joinGap, maxLine }: { joinGap: number; maxLine: number },
  origin: unknown
): void {
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
  doc.transact(() => {
    const transcript = docTranscript(doc)
    const last = transcript.length ? transcript.get(transcript.length - 1) : null
    const lastText = last?.get('text')
    if (
      last &&
      lastText instanceof Y.Text &&
      last.get('cluster') === segment.cluster &&
      last.get('edited') !== true &&
      // The user chose this line's speaker for these words only, not for whatever comes next.
      last.get(USER_CLUSTER) !== true &&
      segment.start - num(last.get('end')) <= joinGap &&
      segment.end - num(last.get('start')) <= maxLine
    ) {
      const joined = oneLine(appendTranscript(lastText.toJSON(), segment.text))
      if (!joined) return
      applyTextChange(lastText, joined)
      last.set('original', joined)
      last.set('end', segment.end)
      const confidence = numOrNull(last.get('confidence'))
      if (segment.confidence !== null) {
        last.set('confidence', confidence === null ? segment.confidence : Math.min(confidence, segment.confidence))
      }
      return
    }
    const text = oneLine(appendTranscript('', segment.text))
    if (text) transcript.push([segmentMap({ ...segment, text })])
  }, origin)
}

function currentRange(doc: Y.Doc): Y.Map<unknown> | null {
  const ranges = docMeta(doc).get('liveRanges')
  if (!(ranges instanceof Y.Array) || ranges.length === 0) return null
  const last: unknown = ranges.get(ranges.length - 1)
  return last instanceof Y.Map ? (last as Y.Map<unknown>) : null
}

/** Where the transcriber writes next, as an index into the notes; null if it hasn't started. */
export function transcriberCursor(doc: Y.Doc): number | null {
  const range = currentRange(doc)
  return range ? readPosition(doc, range.get('cursor')) : null
}

/** Inserts transcribed text at the transcriber's cursor and moves the cursor past it. */
export function transcriberWrite(doc: Y.Doc, inserted: string, origin: unknown): void {
  if (!inserted) return
  const notes = docNotes(doc)
  doc.transact(() => {
    if (!currentRange(doc)) startTranscriber(doc, origin)
    const range = currentRange(doc)
    if (!range) return
    const index = Math.min(readPosition(doc, range.get('cursor')) ?? notes.length, notes.length)
    notes.insert(index, inserted)
    range.set('cursor', stickyPosition(notes, index + inserted.length))
    range.set('text', str(range.get('text')) + inserted)
  }, origin)
}

/**
 * Removes live text from the notes where it is still exactly as transcribed (an edited range
 * is left alone), then forgets all ranges. Returns how many ranges were removed.
 */
export function removeLiveNotes(doc: Y.Doc, origin: unknown): number {
  const ranges = docMeta(doc).get('liveRanges')
  if (!(ranges instanceof Y.Array) || ranges.length === 0) return 0
  let removed = 0
  doc.transact(() => {
    // Back to front, so earlier positions stay valid.
    for (const range of (ranges as Y.Array<Y.Map<unknown>>).toArray().reverse()) {
      if (removeRangeText(doc, range)) removed++
    }
    ;(ranges as Y.Array<Y.Map<unknown>>).delete(0, ranges.length)
  }, origin)
  return removed
}

function findSegment(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  return docTranscript(doc).toArray().find((entry) => entry.get('id') === id) ?? null
}

/** The line carries any user edit, highlights included; such lines are never rejoined. */
function hasOverlay(entry: Y.Map<unknown>): boolean {
  const edits = entry.get('edits')
  return entry.get('edited') === true || (Array.isArray(edits) && edits.length > 0)
}

/** Sets a line's overlay and the text it produces. The original is left as heard. */
export function setSegmentEdits(
  doc: Y.Doc,
  id: string,
  edits: readonly TranscriptEdit[],
  origin: unknown
): void {
  const entry = findSegment(doc, id)
  const text = entry?.get('text')
  if (!entry || !(text instanceof Y.Text)) return
  const original = str(entry.get('original'), text.toJSON())
  doc.transact(() => {
    entry.set('edits', edits.map((edit) => ({ ...edit })))
    applyTextChange(text, applyOverlay(original, edits))
    entry.set('edited', hasTextEdits(edits))
  }, origin)
}

/** The user rewrote a whole line: stored as a correction over the words that changed. */
export function setSegmentText(doc: Y.Doc, id: string, next: string, origin: unknown): void {
  const entry = findSegment(doc, id)
  if (!entry) return
  const segment = readSegment(entry)
  setSegmentEdits(doc, id, rewriteLine(segment.original, segment.edits, next), origin)
}

/**
 * Points one line at a speaker. Done by the user (ORIGIN_USER), it also marks the speaker as
 * their choice, which later passes keep; a machine writer leaves the mark as it is.
 */
function setCluster(entry: Y.Map<unknown>, cluster: string, origin: unknown): void {
  entry.set('cluster', cluster)
  if (origin === ORIGIN_USER && entry.get(USER_CLUSTER) !== true) entry.set(USER_CLUSTER, true)
}

/** Points lines at another speaker (per-line fix, or a split). */
export function setSegmentsCluster(
  doc: Y.Doc,
  ids: readonly string[],
  cluster: string,
  origin: unknown
): void {
  const wanted = new Set(ids)
  doc.transact(() => {
    for (const entry of docTranscript(doc).toArray()) {
      const id = entry.get('id')
      if (typeof id === 'string' && wanted.has(id)) setCluster(entry, cluster, origin)
    }
  }, origin)
}

/** Whether the user chose this line's speaker (see `TranscriptSegment.userCluster`). */
export function isUserAssigned(doc: Y.Doc, lineId: string): boolean {
  return findSegment(doc, lineId)?.get(USER_CLUSTER) === true
}

/** Creates or updates a speaker. Fields left out keep their value. */
export function upsertSpeaker(
  doc: Y.Doc,
  id: string,
  fields: Partial<Omit<SpeakerEntry, 'id'>>,
  origin: unknown
): void {
  const speakers = speakersOf(doc)
  if (!speakers) return
  doc.transact(() => {
    let entry = speakers.get(id)
    if (!(entry instanceof Y.Map)) {
      entry = new Y.Map<unknown>()
      speakers.set(id, entry)
      claimSpeakerId(doc, id)
    }
    for (const [key, value] of Object.entries(fields)) {
      entry.set(key, key === 'matches' ? [...(value as SpeakerMatch[])] : value)
    }
  }, origin)
}

/** Lower-case, no leading `#`, spaces as hyphens: `#Design Review` → `design-review`. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-')
}

export function addTag(doc: Y.Doc, tag: string, origin: unknown): void {
  const clean = normalizeTag(tag)
  const meta = docMeta(doc)
  if (!clean) return
  doc.transact(() => {
    let tags = tagsOf(doc)
    if (!tags) {
      tags = new Y.Array<string>()
      meta.set('tags', tags)
    }
    if (!tags.toArray().includes(clean)) tags.push([clean])
  }, origin)
}

export function removeTag(doc: Y.Doc, tag: string, origin: unknown): void {
  const tags = tagsOf(doc)
  if (!tags) return
  doc.transact(() => {
    const index = tags.toArray().indexOf(tag)
    if (index >= 0) tags.delete(index, 1)
  }, origin)
}

/**
 * The speaker that `id` should merge into once it's named: another speaker who is the same saved
 * person, or (with no saved voice) has the same name. Diarization often splits one person into
 * two clusters; naming both the same is how the user says so.
 */
export function speakerToMergeInto(
  doc: Y.Doc,
  id: string,
  name: string,
  personId: string | null
): string | null {
  const key = name.trim().toLowerCase()
  const other = readSpeakers(doc).find(
    (speaker) =>
      speaker.id !== id &&
      ((personId !== null && speaker.personId === personId) ||
        speaker.name.trim().toLowerCase() === key)
  )
  return other?.id ?? null
}

/**
 * Rejoins consecutive unedited lines of one speaker that a wrong guess had split (a phantom
 * second voice, later merged back), within `maxLine` seconds per line. A line that continues a
 * sentence keeps its lowercase start ("…the weekly" + "planning meeting.").
 */
export function joinSplitLines(doc: Y.Doc, maxLine: number, origin: unknown): void {
  doc.transact(() => {
    const transcript = docTranscript(doc)
    for (let i = transcript.length - 1; i > 0; i--) {
      const line = transcript.get(i)
      const before = transcript.get(i - 1)
      const text = line.get('text')
      const beforeText = before.get('text')
      if (!(text instanceof Y.Text) || !(beforeText instanceof Y.Text)) continue
      if (line.get('cluster') !== before.get('cluster') || line.get('cluster') === null) continue
      if (hasOverlay(line) || hasOverlay(before)) continue
      // A line whose speaker the user chose stays apart from one that's still Lyra's guess.
      if ((line.get(USER_CLUSTER) === true) !== (before.get(USER_CLUSTER) === true)) continue
      if (num(line.get('end')) - num(before.get('start')) > maxLine) continue
      const head = beforeText.toJSON().trimEnd()
      const tail = text.toJSON().trim()
      const continues = !/[.!?:]["')\]]?$/.test(head)
      const joined = `${head} ${continues ? tail.charAt(0).toLowerCase() + tail.slice(1) : tail}`.trim()
      applyTextChange(beforeText, joined)
      before.set('original', joined)
      before.set('end', num(line.get('end')))
      const a = numOrNull(before.get('confidence'))
      const b = numOrNull(line.get('confidence'))
      before.set('confidence', a === null ? b : b === null ? a : Math.min(a, b))
      transcript.delete(i, 1)
    }
  }, origin)
}

/**
 * Renumbers Lyra's placeholder names (Speaker 1, Speaker 2…) in order of first appearance, so a
 * merged-away guess doesn't leave a gap. Names the user gave, or saved voices, are untouched.
 */
export function renumberSpeakers(doc: Y.Doc, origin: unknown): void {
  const speakers = speakersOf(doc)
  if (!speakers) return
  const placeholder = /^Speaker \d+$/
  const order: string[] = []
  for (const line of docTranscript(doc).toArray()) {
    const id = line.get('cluster')
    if (typeof id === 'string' && !order.includes(id)) order.push(id)
  }
  const fixed = new Set<string>()
  speakers.forEach((entry) => {
    const name = str(entry.get('name'))
    if (!placeholder.test(name) || entry.get('confirmed') === true) fixed.add(name)
  })
  doc.transact(() => {
    let n = 1
    for (const id of order) {
      const entry = speakers.get(id)
      if (!entry || entry.get('confirmed') === true || !placeholder.test(str(entry.get('name')))) continue
      while (fixed.has(`Speaker ${String(n)}`)) n++
      const name = `Speaker ${String(n)}`
      if (entry.get('name') !== name) entry.set('name', name)
      n++
    }
  }, origin)
}

/**
 * Gives every line's speaker an entry: a line can point at a speaker that's gone (a relabel that
 * raced a new take used to remove one under it), and then nothing can name or move it. Each
 * missing one comes back as a placeholder "Speaker N". Returns how many were restored.
 */
export function restoreMissingSpeakers(doc: Y.Doc, origin: unknown): number {
  const speakers = speakersOf(doc)
  if (!speakers) return 0
  const missing = new Set<string>()
  for (const line of docTranscript(doc).toArray()) {
    const id = line.get('cluster')
    if (typeof id === 'string' && !speakers.has(id)) missing.add(id)
  }
  if (!missing.size) return 0
  doc.transact(() => {
    for (const id of missing) {
      upsertSpeaker(
        doc,
        id,
        { name: 'Speaker 1', personId: null, confirmed: false, confidence: null, matches: [] },
        origin
      )
    }
    renumberSpeakers(doc, origin)
  }, origin)
  return missing.size
}

/** Removes a speaker, keeping its id from being handed out again. */
export function removeSpeaker(doc: Y.Doc, id: string, origin: unknown): void {
  const speakers = speakersOf(doc)
  if (!speakers?.has(id)) return
  doc.transact(() => {
    claimSpeakerId(doc, id)
    speakers.delete(id)
  }, origin)
}

/**
 * Moves every line of speaker `from` to `into`, then removes `from`. The user merging says those
 * lines are `into`'s, so (as with a move) the next pass keeps them there.
 */
export function mergeSpeakers(doc: Y.Doc, from: string, into: string, origin: unknown): void {
  doc.transact(() => {
    for (const entry of docTranscript(doc).toArray()) {
      if (entry.get('cluster') === from) setCluster(entry, into, origin)
    }
    removeSpeaker(doc, from, origin)
  }, origin)
}

/**
 * The next free speaker number, kept in `meta` and only ever raised. Voiceprints are looked up
 * by speaker id across every raw pass, so an id handed out again after its speaker was merged
 * away would give the new speaker the old one's voice.
 */
const SPEAKER_SEQ = 'speakerSeq'
const SPEAKER_ID = /^c(\d+)$/

function speakerNumber(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const match = SPEAKER_ID.exec(id)
  return match ? Number(match[1]) : null
}

/** Records that `id` has been used, so `newSpeakerId` never returns it again. */
function claimSpeakerId(doc: Y.Doc, id: string): void {
  const n = speakerNumber(id)
  if (n === null || !Number.isSafeInteger(n)) return
  const meta = docMeta(doc)
  if (num(meta.get(SPEAKER_SEQ)) <= n) meta.set(SPEAKER_SEQ, n + 1)
}

/**
 * A speaker id never used in this document: past every id the counter has seen, and every id
 * still in the speakers or the transcript (documents from before the counter).
 */
export function newSpeakerId(doc: Y.Doc): string {
  let next = num(docMeta(doc).get(SPEAKER_SEQ))
  const see = (id: unknown): void => {
    const n = speakerNumber(id)
    if (n !== null && n >= next) next = n + 1
  }
  speakersOf(doc)?.forEach((_value, id) => {
    see(id)
  })
  for (const line of docTranscript(doc).toArray()) see(line.get('cluster'))
  return `c${String(next)}`
}

/** Reads a binary update that arrived over IPC or from disk; anything else is rejected. */
export function asUpdate(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error('Expected a binary document update')
}

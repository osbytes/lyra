import { z } from 'zod'
import { appendTranscript } from './transcriptText'
import {
  applyOverlay,
  expandToEdits,
  hasTextEdits,
  readEdits,
  rewriteLine,
  TranscriptEdit,
  type Span
} from './transcriptOverlay'

/**
 * The editable layer of a session, as plain data. Main owns it (`sessionStore.ts`) and applies
 * every change; windows send it `SessionOp`s and are sent back what changed. See
 * docs/SESSION-MODEL.md.
 *
 * The functions below change a document in place. Main runs them on a copy and commits the
 * copy once they're done, so a writer that throws halfway leaves the session as it was.
 */

/** Below this, a line's voice doesn't sound much like the rest of its speaker. */
export const LOW_CONFIDENCE = 0.6
/** A speaker matched at least this well to a saved voice is shown as a sure match. */
export const SURE_MATCH = 0.85

const finite = z.number().refine(Number.isFinite, 'Expected a finite number')

export const SpeakerMatch = z.object({ personId: z.string(), score: finite })
export type SpeakerMatch = z.infer<typeof SpeakerMatch>

export const SpeakerEntry = z.object({
  id: z.string(),
  name: z.string(),
  personId: z.string().nullable(),
  /** The user named or confirmed this speaker; otherwise it is Lyra's guess. */
  confirmed: z.boolean(),
  /** Voice match for `personId`, 0–1; null when no saved voice matched. */
  confidence: finite.nullable(),
  /** Saved voices ranked by how well they match, best first. */
  matches: z.array(SpeakerMatch)
})
export type SpeakerEntry = z.infer<typeof SpeakerEntry>

export const TranscriptSegment = z.object({
  id: z.string(),
  rawId: z.string().nullable(),
  start: finite,
  end: finite,
  cluster: z.string().nullable(),
  /**
   * The user chose this line's speaker (moved it, or merged its speaker into another). A new
   * pass keeps their choice; without this a move on a live line, which has no raw pass to
   * compare against, would be undone by the next relabel.
   */
  userCluster: z.boolean(),
  /** `original` with `edits` applied, kept so exports and readers needn't apply the overlay. */
  text: z.string(),
  /** What the model heard, before any edit. Locked: edits overlay it, never change it. */
  original: z.string(),
  /** The user's corrections, removals and highlights, as ranges of `original`. */
  edits: z.array(TranscriptEdit),
  /** Some of the words differ from `original` (a highlight alone isn't an edit). */
  edited: z.boolean(),
  /** How much this line's voice sounds like the rest of its speaker, 0–1; null if unknown. */
  confidence: finite.nullable()
})
export type TranscriptSegment = z.infer<typeof TranscriptSegment>

/**
 * How a session's notes were made: the notes pipeline's version, the writer that ran it and
 * when. Lets a bulk run find notes an older pipeline wrote (`notesJobs.ts`).
 */
export const NotesRun = z.strictObject({ pipeline: z.number().int(), writer: z.string(), at: z.string() })
export type NotesRun = z.infer<typeof NotesRun>

export const SessionDoc = z.object({
  title: z.string(),
  /** Generated meeting notes (summary, decisions, actions), above the user's notes. */
  summary: z.string(),
  /** The user's own writing, as markdown. */
  notes: z.string(),
  tags: z.array(z.string()),
  speakers: z.array(SpeakerEntry),
  /** One entry per line, in time order. */
  transcript: z.array(TranscriptSegment),
  /**
   * The next free speaker number, only ever raised. Voiceprints are looked up by speaker id
   * across every raw pass, so an id handed out again after its speaker was merged away would
   * give the new speaker the old one's voice.
   */
  speakerSeq: z.number().int().nonnegative(),
  /** The fingerprint of the summary Lyra last wrote, to tell whether the user edited it since. */
  notesGenerated: z.string().nullable(),
  notesRun: NotesRun.nullable()
})
export type SessionDoc = z.infer<typeof SessionDoc>
/** A session's document as a reader sees it. */
export type SessionSnapshot = SessionDoc

/** The fields a change event can carry: any of the document's. */
export const SessionChanges = SessionDoc.partial()
export type SessionChanges = z.infer<typeof SessionChanges>

export const DOC_FIELDS = Object.keys(SessionDoc.shape) as (keyof SessionDoc)[]

/** A new document with the given title and notes, and nothing else yet. */
export function emptyDoc(init: { title: string; notes: string; summary?: string }): SessionDoc {
  return {
    title: init.title,
    summary: init.summary ?? '',
    notes: init.notes,
    tags: [],
    speakers: [],
    transcript: [],
    speakerSeq: 0,
    notesGenerated: null,
    notesRun: null
  }
}

/** A deep copy, for a writer to change while the committed document stays as it was. */
export const copyDoc = (doc: SessionDoc): SessionDoc => structuredClone(doc)

/** The top-level fields that differ between two documents. */
export function changedFields(before: SessionDoc, after: SessionDoc): (keyof SessionDoc)[] {
  return DOC_FIELDS.filter(
    (key) => before[key] !== after[key] && JSON.stringify(before[key]) !== JSON.stringify(after[key])
  )
}

/** Sets title, summary and/or notes. */
export function editDoc(
  doc: SessionDoc,
  changes: { title?: string | undefined; summary?: string | undefined; notes?: string | undefined }
): void {
  if (changes.title !== undefined) doc.title = changes.title
  if (changes.summary !== undefined) doc.summary = changes.summary
  if (changes.notes !== undefined) doc.notes = changes.notes
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
function segmentOf(
  segment: NewSegment,
  keep?: { text?: TranscriptSegment | undefined; cluster?: string | undefined }
): TranscriptSegment {
  const text = keep?.text
  return {
    id: segment.id,
    rawId: segment.rawId,
    start: segment.start,
    end: segment.end,
    cluster: keep?.cluster ?? segment.cluster,
    userCluster: keep?.cluster !== undefined || segment.userCluster === true,
    // A kept line keeps the words its edits were made over, so they still line up.
    text: text ? text.text : segment.text,
    original: text ? text.original : segment.text,
    edits: text ? text.edits.map((edit) => ({ ...edit })) : [],
    edited: text?.edited === true,
    confidence: segment.confidence
  }
}

/** The line carries any user edit, highlights included; such lines are never rejoined. */
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

const speakerOf = (doc: SessionDoc, id: string): SpeakerEntry | undefined =>
  doc.speakers.find((speaker) => speaker.id === id)

/**
 * Replaces the transcript with a new pass. A line the user edited keeps their text, and a line
 * whose speaker the user chose keeps that speaker (while it still exists), when the new pass has
 * a line over the same stretch of audio, so re-labeling never undoes either.
 *
 * Lines at the start that the pass leaves exactly as they are stay as they are: while recording
 * the speakers are settled again every half minute, mostly changing only the newest lines.
 */
export function replaceTranscript(doc: SessionDoc, segments: NewSegment[]): void {
  const existing = doc.transcript
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
    if (!keep) return segmentOf(segment)
    used.add(keep.id)
    const cluster =
      keep.userCluster && keep.cluster !== null && speakerOf(doc, keep.cluster) ? keep.cluster : undefined
    return segmentOf(segment, { text: hasEdits(keep) ? keep : undefined, cluster })
  })
  doc.transcript = [...existing.slice(0, same), ...entries]
}

/**
 * A live transcript line. Words from the same speaker within `joinGap` seconds of their last
 * line extend it (one line per turn, up to `maxLine` seconds), unless the user edited that line.
 * Text is joined with the dictation rules (spacing, capitals, voice commands) on one line.
 */
export function appendLiveSegment(
  doc: SessionDoc,
  segment: NewSegment,
  { joinGap, maxLine }: { joinGap: number; maxLine: number }
): void {
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const last = doc.transcript.at(-1)
  if (
    last?.cluster === segment.cluster &&
    !last.edited &&
    // The user chose this line's speaker for these words only, not for whatever comes next.
    !last.userCluster &&
    segment.start - last.end <= joinGap &&
    segment.end - last.start <= maxLine
  ) {
    const joined = oneLine(appendTranscript(last.text, segment.text))
    if (!joined) return
    last.text = joined
    last.original = joined
    last.end = segment.end
    if (segment.confidence !== null) {
      last.confidence =
        last.confidence === null ? segment.confidence : Math.min(last.confidence, segment.confidence)
    }
    return
  }
  const text = oneLine(appendTranscript('', segment.text))
  if (text) doc.transcript.push(segmentOf({ ...segment, text }))
}

const findSegment = (doc: SessionDoc, id: string): TranscriptSegment | undefined =>
  doc.transcript.find((line) => line.id === id)

/** Sets a line's overlay and the text it produces. The original is left as heard. */
export function setSegmentEdits(doc: SessionDoc, id: string, edits: readonly TranscriptEdit[]): void {
  const line = findSegment(doc, id)
  if (!line) return
  // Ranges past the line's words (from a window that saw an older line) are dropped.
  const valid = readEdits(edits, line.original.length)
  line.edits = valid
  line.text = applyOverlay(line.original, valid)
  line.edited = hasTextEdits(valid)
}

/** The user rewrote a whole line: stored as a correction over the words that changed. */
export function setSegmentText(doc: SessionDoc, id: string, next: string): void {
  const line = findSegment(doc, id)
  if (line) setSegmentEdits(doc, id, rewriteLine(line.original, line.edits, next))
}

/**
 * Points lines at another speaker (per-line fix, or a split). Done by the user, it also marks
 * the speaker as their choice, which later passes keep; a machine writer leaves the mark as is.
 */
export function setSegmentsCluster(
  doc: SessionDoc,
  ids: readonly string[],
  cluster: string,
  byUser: boolean
): void {
  const wanted = new Set(ids)
  for (const line of doc.transcript) {
    if (!wanted.has(line.id)) continue
    line.cluster = cluster
    if (byUser) line.userCluster = true
  }
}

/**
 * Gives some of a line's words to another speaker: the line becomes up to three (the words
 * before, the span, the words after), and the span's line is the user's choice of speaker, so a
 * relabel pins those words to it. A line keeps no word times, so its time is shared out by
 * length. Ids are made from the line's id and offsets: applying the split twice does nothing.
 */
export function splitLineSpeaker(
  doc: SessionDoc,
  id: string,
  span: Span,
  cluster: string
): void {
  const index = doc.transcript.findIndex((line) => line.id === id)
  const line = doc.transcript[index]
  if (!line) return
  const { original } = line
  // A correction or removal goes whole to one side, never cut in half.
  const cut = expandToEdits(line.edits, {
    start: Math.max(0, Math.min(span.start, original.length)),
    end: Math.max(0, Math.min(span.end, original.length))
  })
  if (!original.slice(cut.start, cut.end).trim()) return
  // Punctuation alone on either side ends or starts the chosen words, not a line of its own.
  const bare = (text: string): boolean => /^[\s\p{P}]*$/u.test(text)
  if (bare(original.slice(0, cut.start))) cut.start = 0
  if (bare(original.slice(cut.end))) cut.end = original.length
  const at = (offset: number): number =>
    original.length ? line.start + ((line.end - line.start) * offset) / original.length : line.start
  const piece = (from: number, to: number, own: boolean): TranscriptSegment | null => {
    let a = from
    let b = to
    while (a < b && /\s/.test(original.charAt(a))) a++
    while (b > a && /\s/.test(original.charAt(b - 1))) b--
    if (b <= a) return null
    const edits = line.edits.flatMap((edit): TranscriptEdit[] => {
      const start = Math.max(edit.start, a)
      const end = Math.min(edit.end, b)
      const inside = edit.start === edit.end ? edit.start >= a && edit.start <= b : end > start
      return inside ? [{ ...edit, start: start - a, end: end - a }] : []
    })
    const words = original.slice(a, b)
    const valid = readEdits(edits, words.length)
    return {
      id: `${id}.${String(a)}`,
      // The pass didn't give the moved words their speaker, so they no longer stand for its line.
      rawId: own ? null : line.rawId,
      start: at(from),
      end: at(to),
      cluster: own ? cluster : line.cluster,
      userCluster: own || line.userCluster,
      text: applyOverlay(words, valid),
      original: words,
      edits: valid,
      edited: hasTextEdits(valid),
      confidence: own ? null : line.confidence
    }
  }
  const pieces = [
    piece(0, cut.start, false),
    piece(cut.start, cut.end, true),
    piece(cut.end, original.length, false)
  ].filter((entry) => entry !== null)
  // The whole line: a plain move, which keeps the line as it is.
  if (pieces.length === 1) setSegmentsCluster(doc, [id], cluster, true)
  else doc.transcript.splice(index, 1, ...pieces)
}

/** Whether the user chose this line's speaker (see `TranscriptSegment.userCluster`). */
export function isUserAssigned(doc: SessionDoc, lineId: string): boolean {
  return findSegment(doc, lineId)?.userCluster === true
}

/** Creates or updates a speaker. Fields left out keep their value. */
export function upsertSpeaker(
  doc: SessionDoc,
  id: string,
  fields: Partial<Omit<SpeakerEntry, 'id'>>
): void {
  const entry = speakerOf(doc, id)
  const defined = { ...fields }
  if (defined.matches) defined.matches = defined.matches.map((match) => ({ ...match }))
  if (entry) {
    Object.assign(entry, defined)
    return
  }
  doc.speakers.push({
    name: id,
    personId: null,
    confirmed: false,
    confidence: null,
    matches: [],
    ...defined,
    id
  })
  claimSpeakerId(doc, id)
}

/** Lower-case, no leading `#`, spaces as hyphens: `#Design Review` → `design-review`. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-')
}

export function addTag(doc: SessionDoc, tag: string): void {
  const clean = normalizeTag(tag)
  if (clean && !doc.tags.includes(clean)) doc.tags.push(clean)
}

export function removeTag(doc: SessionDoc, tag: string): void {
  doc.tags = doc.tags.filter((existing) => existing !== tag)
}

/**
 * The speaker that `id` should merge into once it's named: another speaker who is the same saved
 * person, or (with no saved voice) has the same name. Diarization often splits one person into
 * two clusters; naming both the same is how the user says so.
 */
export function speakerToMergeInto(
  doc: SessionDoc,
  id: string,
  name: string,
  personId: string | null
): string | null {
  const key = name.trim().toLowerCase()
  const other = doc.speakers.find(
    (speaker) =>
      speaker.id !== id &&
      ((personId !== null && speaker.personId === personId) || speaker.name.trim().toLowerCase() === key)
  )
  return other?.id ?? null
}

/**
 * Rejoins consecutive unedited lines of one speaker that a wrong guess had split (a phantom
 * second voice, later merged back), within `maxLine` seconds per line. A line that continues a
 * sentence keeps its lowercase start ("…the weekly" + "planning meeting.").
 */
export function joinSplitLines(doc: SessionDoc, maxLine: number): void {
  const lines = doc.transcript
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i]
    const before = lines[i - 1]
    if (!line || !before) continue
    if (line.cluster !== before.cluster || line.cluster === null) continue
    if (hasEdits(line) || hasEdits(before)) continue
    // A line whose speaker the user chose stays apart from one that's still Lyra's guess.
    if (line.userCluster !== before.userCluster) continue
    if (line.end - before.start > maxLine) continue
    const head = before.text.trimEnd()
    const tail = line.text.trim()
    const continues = !/[.!?:]["')\]]?$/.test(head)
    const joined = `${head} ${continues ? tail.charAt(0).toLowerCase() + tail.slice(1) : tail}`.trim()
    before.text = joined
    before.original = joined
    before.end = line.end
    const a = before.confidence
    const b = line.confidence
    before.confidence = a === null ? b : b === null ? a : Math.min(a, b)
    lines.splice(i, 1)
  }
}

/**
 * Renumbers Lyra's placeholder names (Speaker 1, Speaker 2…) in order of first appearance, so a
 * merged-away guess doesn't leave a gap. Names the user gave, or saved voices, are untouched.
 */
export function renumberSpeakers(doc: SessionDoc): void {
  const placeholder = /^Speaker \d+$/
  const order: string[] = []
  for (const line of doc.transcript) {
    if (line.cluster !== null && !order.includes(line.cluster)) order.push(line.cluster)
  }
  const fixed = new Set(
    doc.speakers
      .filter((entry) => !placeholder.test(entry.name) || entry.confirmed)
      .map((entry) => entry.name)
  )
  let n = 1
  for (const id of order) {
    const entry = speakerOf(doc, id)
    if (!entry || entry.confirmed || !placeholder.test(entry.name)) continue
    while (fixed.has(`Speaker ${String(n)}`)) n++
    entry.name = `Speaker ${String(n)}`
    n++
  }
}

/**
 * Gives every line's speaker an entry: a line can point at a speaker that's gone (a relabel that
 * raced a new take used to remove one under it), and then nothing can name or move it. Each
 * missing one comes back as a placeholder "Speaker N". Returns how many were restored.
 */
export function restoreMissingSpeakers(doc: SessionDoc): number {
  const missing = new Set<string>()
  for (const line of doc.transcript) {
    if (line.cluster !== null && !speakerOf(doc, line.cluster)) missing.add(line.cluster)
  }
  if (!missing.size) return 0
  for (const id of missing) {
    upsertSpeaker(doc, id, {
      name: 'Speaker 1',
      personId: null,
      confirmed: false,
      confidence: null,
      matches: []
    })
  }
  renumberSpeakers(doc)
  return missing.size
}

/** Removes a speaker, keeping its id from being handed out again. */
export function removeSpeaker(doc: SessionDoc, id: string): void {
  if (!speakerOf(doc, id)) return
  claimSpeakerId(doc, id)
  doc.speakers = doc.speakers.filter((speaker) => speaker.id !== id)
}

/**
 * Moves every line of speaker `from` to `into`, then removes `from`. The user merging says those
 * lines are `into`'s, so (as with a move) the next pass keeps them there.
 */
export function mergeSpeakers(doc: SessionDoc, from: string, into: string, byUser: boolean): void {
  const ids = doc.transcript.filter((line) => line.cluster === from).map((line) => line.id)
  setSegmentsCluster(doc, ids, into, byUser)
  removeSpeaker(doc, from)
}

const SPEAKER_ID = /^c(\d+)$/

function speakerNumber(id: string | null): number | null {
  if (id === null) return null
  const match = SPEAKER_ID.exec(id)
  return match ? Number(match[1]) : null
}

/** Records that `id` has been used, so `newSpeakerId` never returns it again. */
function claimSpeakerId(doc: SessionDoc, id: string): void {
  const n = speakerNumber(id)
  if (n !== null && Number.isSafeInteger(n) && doc.speakerSeq <= n) doc.speakerSeq = n + 1
}

/**
 * A speaker id never used in this document: past every id the counter has seen, and every id
 * still in the speakers or the transcript.
 */
export function newSpeakerId(doc: SessionDoc): string {
  let next = doc.speakerSeq
  const see = (id: string | null): void => {
    const n = speakerNumber(id)
    if (n !== null && n >= next) next = n + 1
  }
  for (const speaker of doc.speakers) see(speaker.id)
  for (const line of doc.transcript) see(line.cluster)
  return `c${String(next)}`
}

// --- Edits from a window ----------------------------------------------------------------

const NewSpeakerFields = z.object({
  name: z.string(),
  personId: z.string().nullable(),
  confirmed: z.boolean()
})

/** The fields of a line that the user's edits change, and undo puts back. */
const LineFields = TranscriptSegment.pick({
  cluster: true,
  userCluster: true,
  text: true,
  edits: true,
  edited: true
})
type LineFields = z.infer<typeof LineFields>

const swap = <T extends z.ZodType>(value: T) => z.object({ from: value, to: value })

/**
 * A change and what it changed back from, for undo and redo. Each part is put back only while
 * the session still holds what the change left there, so undo never takes back something
 * written since (a relabel, another window).
 */
export const SessionPatch = z.object({
  title: swap(z.string()).optional(),
  summary: swap(z.string()).optional(),
  tags: swap(z.array(z.string())).optional(),
  speakers: z
    .array(z.object({ id: z.string(), from: SpeakerEntry.nullable(), to: SpeakerEntry.nullable() }))
    .optional(),
  lines: z.array(z.object({ id: z.string(), from: LineFields, to: LineFields })).optional(),
  /** A run of lines that became other lines (a line split between speakers). */
  runs: z
    .array(z.object({ from: z.array(TranscriptSegment).min(1), to: z.array(TranscriptSegment).min(1) }))
    .optional()
})
export type SessionPatch = z.infer<typeof SessionPatch>

/**
 * An edit a window sends. Each sets a value rather than changing one by an amount, so applying
 * it twice (a window shows its own edit before main confirms it) does no harm.
 */
export const SessionOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('title'), title: z.string() }),
  z.object({ op: z.literal('notes'), notes: z.string() }),
  z.object({ op: z.literal('summary'), summary: z.string() }),
  z.object({ op: z.literal('tag'), tag: z.string() }),
  z.object({ op: z.literal('untag'), tag: z.string() }),
  z.object({ op: z.literal('lineEdits'), id: z.string(), edits: z.array(TranscriptEdit) }),
  z.object({ op: z.literal('lineText'), id: z.string(), text: z.string() }),
  /** Moves lines to a speaker, creating it first when `create` is given. */
  z.object({
    op: z.literal('assign'),
    ids: z.array(z.string()),
    speaker: z.string(),
    create: NewSpeakerFields.optional()
  }),
  /** Gives a line's words in `[start, end)` to a speaker, creating it first when `create` is given. */
  z.object({
    op: z.literal('splitLine'),
    id: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    speaker: z.string(),
    create: NewSpeakerFields.optional()
  }),
  /** Names a speaker, merging it into another with the same name or saved person. */
  z.object({ op: z.literal('name'), id: z.string(), name: z.string(), personId: z.string().nullable() }),
  /** Undo or redo: puts back what a patch changed. */
  z.object({ op: z.literal('restore'), patch: SessionPatch })
])
export type SessionOp = z.infer<typeof SessionOp>

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const lineFields = (line: TranscriptSegment): LineFields => ({
  cluster: line.cluster,
  userCluster: line.userCluster,
  text: line.text,
  edits: line.edits,
  edited: line.edited
})

function applyPatch(doc: SessionDoc, patch: SessionPatch): void {
  if (doc.title === patch.title?.from) doc.title = patch.title.to
  if (doc.summary === patch.summary?.from) doc.summary = patch.summary.to
  if (patch.tags) {
    const { from, to } = patch.tags
    const removed = new Set(from.filter((tag) => !to.includes(tag)))
    const added = to.filter((tag) => !from.includes(tag) && !doc.tags.includes(tag))
    doc.tags = [...doc.tags.filter((tag) => !removed.has(tag)), ...added]
  }
  for (const { id, from, to } of patch.speakers ?? []) {
    const index = doc.speakers.findIndex((speaker) => speaker.id === id)
    const current = index >= 0 ? doc.speakers[index] : null
    if (!same(current ?? null, from)) continue
    if (to === null) removeSpeaker(doc, id)
    else if (index >= 0) doc.speakers[index] = structuredClone(to)
    else {
      doc.speakers.push(structuredClone(to))
      claimSpeakerId(doc, id)
    }
  }
  for (const { id, from, to } of patch.lines ?? []) {
    const line = findSegment(doc, id)
    if (line && same(lineFields(line), from)) Object.assign(line, structuredClone(to))
  }
  for (const { from, to } of patch.runs ?? []) {
    const index = doc.transcript.findIndex((line) => line.id === from[0]?.id)
    if (index < 0 || !same(doc.transcript.slice(index, index + from.length), from)) continue
    doc.transcript.splice(index, from.length, ...structuredClone(to))
  }
}

/** Applies a window's edit. */
export function applyOp(doc: SessionDoc, op: SessionOp): void {
  switch (op.op) {
    case 'title':
      doc.title = op.title
      return
    case 'notes':
      doc.notes = op.notes
      return
    case 'summary':
      doc.summary = op.summary
      return
    case 'tag':
      addTag(doc, op.tag)
      return
    case 'untag':
      removeTag(doc, op.tag)
      return
    case 'lineEdits':
      setSegmentEdits(doc, op.id, op.edits)
      return
    case 'lineText':
      setSegmentText(doc, op.id, op.text)
      return
    case 'assign':
      if (op.create) upsertSpeaker(doc, op.speaker, { ...op.create, confidence: null, matches: [] })
      setSegmentsCluster(doc, op.ids, op.speaker, true)
      return
    case 'splitLine':
      if (op.create) upsertSpeaker(doc, op.speaker, { ...op.create, confidence: null, matches: [] })
      splitLineSpeaker(doc, op.id, { start: op.start, end: op.end }, op.speaker)
      return
    case 'name': {
      const into = speakerToMergeInto(doc, op.id, op.name, op.personId)
      upsertSpeaker(doc, into ?? op.id, { name: op.name, personId: op.personId, confirmed: true })
      if (into) mergeSpeakers(doc, op.id, into, true)
      return
    }
    case 'restore':
      applyPatch(doc, op.patch)
      return
  }
}

/** What a change did to the parts undo covers (not the notes: their editor keeps its own). */
export function patchBetween(before: SessionDoc, after: SessionDoc): SessionPatch | null {
  const patch: SessionPatch = {}
  if (before.title !== after.title) patch.title = { from: before.title, to: after.title }
  if (before.summary !== after.summary) patch.summary = { from: before.summary, to: after.summary }
  if (!same(before.tags, after.tags)) patch.tags = { from: before.tags, to: after.tags }
  const ids = new Set([...before.speakers, ...after.speakers].map((speaker) => speaker.id))
  const speakers = [...ids].flatMap((id) => {
    const from = before.speakers.find((speaker) => speaker.id === id) ?? null
    const to = after.speakers.find((speaker) => speaker.id === id) ?? null
    return same(from, to) ? [] : [{ id, from, to }]
  })
  if (speakers.length) patch.speakers = speakers
  const run = changedRun(before.transcript, after.transcript)
  if (run) patch.runs = [run]
  const inRun = new Set(run?.to.map((line) => line.id))
  const old = new Map(before.transcript.map((line) => [line.id, line]))
  const lines = after.transcript.flatMap((line) => {
    const was = old.get(line.id)
    if (!was || inRun.has(line.id)) return []
    const from = lineFields(was)
    const to = lineFields(line)
    return same(from, to) ? [] : [{ id: line.id, from, to }]
  })
  if (lines.length) patch.lines = lines
  // A copy: the documents' arrays and entries may be changed in place after this.
  return Object.keys(patch).length ? structuredClone(patch) : null
}

/**
 * Where the lines themselves changed (not just their fields): the run between the lines both
 * transcripts start and end with. Null when every line is still there, in order.
 */
function changedRun(
  before: readonly TranscriptSegment[],
  after: readonly TranscriptSegment[]
): { from: TranscriptSegment[]; to: TranscriptSegment[] } | null {
  const shorter = Math.min(before.length, after.length)
  let head = 0
  while (head < shorter && before[head]?.id === after[head]?.id) head++
  if (head === before.length && head === after.length) return null
  let tail = 0
  while (
    tail < shorter - head &&
    before[before.length - 1 - tail]?.id === after[after.length - 1 - tail]?.id
  ) {
    tail++
  }
  const from = before.slice(head, before.length - tail)
  const to = after.slice(head, after.length - tail)
  // Undo finds a run by its first line, so lines only added or only removed aren't covered.
  return from.length && to.length ? { from, to } : null
}

/** The patch that takes a change back. */
export function invertPatch(patch: SessionPatch): SessionPatch {
  const flip = <T,>(part: { from: T; to: T } | undefined): { from: T; to: T } | undefined =>
    part && { from: part.to, to: part.from }
  const out: SessionPatch = {}
  const title = flip(patch.title)
  const summary = flip(patch.summary)
  const tags = flip(patch.tags)
  if (title) out.title = title
  if (summary) out.summary = summary
  if (tags) out.tags = tags
  if (patch.speakers) out.speakers = patch.speakers.map(({ id, from, to }) => ({ id, from: to, to: from }))
  if (patch.lines) out.lines = patch.lines.map(({ id, from, to }) => ({ id, from: to, to: from }))
  if (patch.runs) out.runs = patch.runs.map(({ from, to }) => ({ from: to, to: from })).reverse()
  return out
}

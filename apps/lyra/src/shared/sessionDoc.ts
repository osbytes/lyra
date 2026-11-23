import * as Y from 'yjs'

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
 *     segment: { id, rawId, start, end, cluster, text: Y.Text, original, edited, confidence }
 */

/** Who made a change. Lets undo skip machine writes and lets main skip echoing a window. */
export const ORIGIN_USER = 'user'
export const ORIGIN_REMOTE = 'remote'

/** Below this, a line's voice doesn't sound much like the rest of its speaker. */
export const LOW_CONFIDENCE = 0.6
/** A speaker matched at least this well to a saved voice is shown as a sure match. */
export const SURE_MATCH = 0.85

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
  text: string
  /** What the model heard, before any edit. */
  original: string
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
  return {
    id: str(entry.get('id')),
    rawId: typeof rawId === 'string' ? rawId : null,
    start: num(entry.get('start')),
    end: num(entry.get('end')),
    cluster: typeof cluster === 'string' ? cluster : null,
    text: current,
    original: str(entry.get('original'), current),
    edited: entry.get('edited') === true,
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
  changes: { title?: string; summary?: string; notes?: string },
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

export type NewSegment = Omit<TranscriptSegment, 'text' | 'original' | 'edited'> & {
  text: string
}

function segmentMap(segment: NewSegment, keep?: TranscriptSegment): Y.Map<unknown> {
  const entry = new Y.Map<unknown>()
  entry.set('id', segment.id)
  entry.set('rawId', segment.rawId)
  entry.set('start', segment.start)
  entry.set('end', segment.end)
  entry.set('cluster', segment.cluster)
  entry.set('confidence', segment.confidence)
  entry.set('original', segment.text)
  entry.set('text', new Y.Text(keep?.edited ? keep.text : segment.text))
  entry.set('edited', keep?.edited === true)
  return entry
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * Replaces the transcript with a new pass. A line the user edited keeps their text when the
 * new pass has a line over the same stretch of audio, so re-labeling never undoes an edit.
 */
export function replaceTranscript(doc: Y.Doc, segments: NewSegment[], origin: unknown): void {
  doc.transact(() => {
    const transcript = docTranscript(doc)
    const edited = transcript.toArray().map(readSegment).filter((segment) => segment.edited)
    const used = new Set<string>()
    const entries = segments.map((segment) => {
      const keep = edited
        .filter((old) => !used.has(old.id))
        .map((old) => ({ old, shared: overlap(old, segment) }))
        .filter(({ old, shared }) => shared > 0.5 * Math.min(old.end - old.start, segment.end - segment.start))
        .sort((a, b) => b.shared - a.shared)[0]?.old
      if (keep) used.add(keep.id)
      return segmentMap(segment, keep)
    })
    transcript.delete(0, transcript.length)
    transcript.insert(0, entries)
  }, origin)
}

/** Live words during a meeting: extend the last unlabeled segment, or start one. */
export function appendLiveText(
  doc: Y.Doc,
  text: string,
  at: { start: number; end: number },
  origin: unknown
): void {
  if (!text) return
  doc.transact(() => {
    const transcript = docTranscript(doc)
    const last = transcript.length ? transcript.get(transcript.length - 1) : null
    const lastText = last?.get('text')
    if (last?.get('cluster') === null && last.get('edited') !== true && lastText instanceof Y.Text) {
      lastText.insert(lastText.length, text)
      last.set('original', lastText.toJSON())
      last.set('end', at.end)
      return
    }
    transcript.push([
      segmentMap({
        id: `live-${String(transcript.length)}`,
        rawId: null,
        start: at.start,
        end: at.end,
        cluster: null,
        confidence: null,
        text: text.trimStart()
      })
    ])
  }, origin)
}

function findSegment(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  return docTranscript(doc).toArray().find((entry) => entry.get('id') === id) ?? null
}

/** The user typed into a line. */
export function setSegmentText(doc: Y.Doc, id: string, next: string, origin: unknown): void {
  const entry = findSegment(doc, id)
  const text = entry?.get('text')
  if (!entry || !(text instanceof Y.Text)) return
  doc.transact(() => {
    applyTextChange(text, next)
    entry.set('edited', next !== str(entry.get('original')))
  }, origin)
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
      if (typeof id === 'string' && wanted.has(id)) entry.set('cluster', cluster)
    }
  }, origin)
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
    }
    for (const [key, value] of Object.entries(fields)) {
      entry.set(key, key === 'matches' ? [...(value as SpeakerMatch[])] : value)
    }
  }, origin)
}

/** A speaker id not used yet in this document. */
export function newSpeakerId(doc: Y.Doc): string {
  const taken = new Set<string>()
  speakersOf(doc)?.forEach((_value, id) => taken.add(id))
  let n = taken.size
  while (taken.has(`c${String(n)}`)) n++
  return `c${String(n)}`
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

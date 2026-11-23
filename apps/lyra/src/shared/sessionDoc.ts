import * as Y from 'yjs'

/**
 * The editable layer of a session, as a Yjs document. Main owns the copy on disk; each window
 * holds a replica kept in sync over IPC. See docs/SESSION-MODEL.md.
 *
 * Shape:
 *   title: Y.Text
 *   notes: Y.Text
 *   meta: Y.Map { tags: Y.Array<string>, speakers: Y.Map<Y.Map> }
 *   transcript: Y.Array<Y.Map { id, rawId, start, end, cluster, text: Y.Text, edited }>
 */

/** Who made a change. Lets undo skip machine writes and lets main skip echoing a window. */
export const ORIGIN_USER = 'user'
export const ORIGIN_REMOTE = 'remote'

export type SpeakerEntry = {
  id: string
  name: string
  personId: string | null
  confirmed: boolean
}

export type TranscriptSegment = {
  id: string
  rawId: string | null
  start: number
  end: number
  cluster: string | null
  text: string
  edited: boolean
}

export type SessionSnapshot = {
  title: string
  notes: string
  tags: string[]
  speakers: SpeakerEntry[]
  transcript: TranscriptSegment[]
}

export const docTitle = (doc: Y.Doc): Y.Text => doc.getText('title')
export const docNotes = (doc: Y.Doc): Y.Text => doc.getText('notes')
export const docMeta = (doc: Y.Doc): Y.Map<unknown> => doc.getMap('meta')
export const docTranscript = (doc: Y.Doc): Y.Array<Y.Map<unknown>> => doc.getArray('transcript')

function tagsOf(doc: Y.Doc): Y.Array<string> | null {
  const tags = docMeta(doc).get('tags')
  return tags instanceof Y.Array ? (tags as Y.Array<string>) : null
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function readSpeakers(doc: Y.Doc): SpeakerEntry[] {
  const speakers = docMeta(doc).get('speakers')
  if (!(speakers instanceof Y.Map)) return []
  const out: SpeakerEntry[] = []
  speakers.forEach((value: unknown, id: string) => {
    if (!(value instanceof Y.Map)) return
    const entry = value as Y.Map<unknown>
    const personId = entry.get('personId')
    out.push({
      id,
      name: str(entry.get('name'), id),
      personId: typeof personId === 'string' ? personId : null,
      confirmed: entry.get('confirmed') === true
    })
  })
  return out
}

function readTranscript(doc: Y.Doc): TranscriptSegment[] {
  return docTranscript(doc)
    .toArray()
    .map((entry) => {
      const text = entry.get('text')
      const rawId = entry.get('rawId')
      const cluster = entry.get('cluster')
      return {
        id: str(entry.get('id')),
        rawId: typeof rawId === 'string' ? rawId : null,
        start: num(entry.get('start')),
        end: num(entry.get('end')),
        cluster: typeof cluster === 'string' ? cluster : null,
        text: text instanceof Y.Text ? text.toJSON() : '',
        edited: entry.get('edited') === true
      }
    })
}

export function snapshotOf(doc: Y.Doc): SessionSnapshot {
  return {
    title: docTitle(doc).toJSON(),
    notes: docNotes(doc).toJSON(),
    tags: tagsOf(doc)?.toArray().filter((tag): tag is string => typeof tag === 'string') ?? [],
    speakers: readSpeakers(doc),
    transcript: readTranscript(doc)
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

/** Sets title and/or notes in one transaction. */
export function editDoc(
  doc: Y.Doc,
  changes: { title?: string; notes?: string },
  origin: unknown
): void {
  doc.transact(() => {
    if (changes.title !== undefined) applyTextChange(docTitle(doc), changes.title)
    if (changes.notes !== undefined) applyTextChange(docNotes(doc), changes.notes)
  }, origin)
}

/** A new document with the given title and notes, and empty tags, speakers and transcript. */
export function initDoc(doc: Y.Doc, init: { title: string; notes: string }, origin: unknown): void {
  doc.transact(() => {
    const meta = docMeta(doc)
    if (!(meta.get('tags') instanceof Y.Array)) meta.set('tags', new Y.Array<string>())
    if (!(meta.get('speakers') instanceof Y.Map)) meta.set('speakers', new Y.Map())
    applyTextChange(docTitle(doc), init.title)
    applyTextChange(docNotes(doc), init.notes)
  }, origin)
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

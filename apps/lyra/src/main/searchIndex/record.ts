import { createHash } from 'node:crypto'
import type { SessionSnapshot } from '../../shared/sessionDoc'
import type { SessionManifest } from '../sessionStore'
import type { ChunkRecord, SessionRecord } from './protocol'

/** About 250 tokens: long enough to carry a thought, short enough to be about one thing. */
const CHUNK_CHARS = 1000
/** A transcript window also ends after this much talk. */
const WINDOW_SECONDS = 45

type ChunkFields = Omit<ChunkRecord, 'input' | 'hash'>

function chunk(fields: ChunkFields, title: string): ChunkRecord {
  const input = title ? `${title}\n${fields.text}` : fields.text
  return { ...fields, input, hash: createHash('sha256').update(input).digest('hex') }
}

/** Paragraphs merged up to CHUNK_CHARS. */
function textChunks(field: 'summary' | 'notes', text: string): ChunkFields[] {
  const out: ChunkFields[] = []
  let current = ''
  const flush = (): void => {
    if (current) out.push({ field, segmentId: null, cluster: null, start: null, end: null, text: current })
    current = ''
  }
  for (const paragraph of paragraphs(text)) {
    if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) flush()
    current = current ? `${current}\n\n${paragraph}` : paragraph
  }
  flush()
  return out
}

/**
 * Windows of consecutive transcript lines as `Name: text`, each up to CHUNK_CHARS or
 * WINDOW_SECONDS. Each window repeats the previous one's last line, so a thought that spans the
 * cut is whole in one of them. A window points at its first line, to jump there.
 */
function transcriptChunks(snapshot: SessionSnapshot): ChunkFields[] {
  const names = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.name]))
  const lines = snapshot.transcript
    .filter((line) => line.text.trim())
    .map((line) => ({ line, text: `${line.cluster ? (names.get(line.cluster) ?? 'Speaker') : 'Speaker'}: ${line.text.trim()}` }))
  const out: ChunkFields[] = []
  let from = 0
  while (from < lines.length) {
    const start = lines[from]?.line.start ?? 0
    let to = from
    let length = 0
    for (const entry of lines.slice(from)) {
      if (to > from && (length + entry.text.length > CHUNK_CHARS || entry.line.end - start > WINDOW_SECONDS)) break
      length += entry.text.length + 1
      to++
    }
    const window = lines.slice(from, to)
    const [first] = window
    const last = window.at(-1)
    if (!first || !last) break
    out.push({
      field: 'transcript',
      segmentId: first.line.id,
      cluster: first.line.cluster,
      start: first.line.start,
      end: last.line.end,
      text: window.map((entry) => entry.text).join('\n')
    })
    if (to >= lines.length) break
    from = to - from > 1 ? to - 1 : to
  }
  return out
}

/**
 * Only the first chunk leads with the title: it gives the session's opening its topic, while a
 * rename (auto-titles come after the first minutes of talk) re-embeds one chunk, not all of
 * them. Changing what goes into `input` means bumping EMBED_RECIPE (embedder.ts).
 */
export function chunksOf(snapshot: SessionSnapshot): ChunkRecord[] {
  const title = snapshot.title.trim()
  return [
    ...textChunks('summary', snapshot.summary),
    ...textChunks('notes', snapshot.notes),
    ...transcriptChunks(snapshot)
  ].map((fields, index) => chunk(fields, index === 0 ? title : ''))
}

/** Paragraphs of notes or a summary; a list item counts as its own paragraph. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=[-*•—]\s)/)
    .map((part) => part.trim())
    .filter(Boolean)
}

const ACTION_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/

/**
 * Action items from generated notes, which renders them as `- [ ] Owner: task`
 * (meeting/notesFormat.ts). A line without an owner keeps its whole text as the task.
 */
export function actionItemsOf(summary: string): SessionRecord['actionItems'] {
  const items: SessionRecord['actionItems'] = []
  for (const line of summary.split(/\r?\n/)) {
    const match = ACTION_ITEM.exec(line)
    if (!match) continue
    const [, mark = ' ', rest = ''] = match
    const colon = rest.indexOf(': ')
    const owner = colon > 0 ? rest.slice(0, colon).trim() : ''
    items.push({
      owner: owner || null,
      task: (colon > 0 ? rest.slice(colon + 2) : rest).trim(),
      done: mark !== ' '
    })
  }
  return items
}

function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** What the search index stores for a session, from its manifest and document. */
export function sessionRecordOf(id: string, manifest: SessionManifest, snapshot: SessionSnapshot): SessionRecord {
  const talk = new Map<string, { seconds: number; segments: number }>()
  for (const segment of snapshot.transcript) {
    if (!segment.cluster) continue
    const sum = talk.get(segment.cluster) ?? { seconds: 0, segments: 0 }
    sum.seconds += Math.max(0, segment.end - segment.start)
    sum.segments++
    talk.set(segment.cluster, sum)
  }
  const base = { segmentId: null, cluster: null, start: null }
  const title = snapshot.title.trim()
  return {
    id,
    title: manifest.title,
    titleAuto: manifest.titleAuto,
    preview: manifest.preview,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    updatedAt: manifest.updatedAt,
    seconds: manifest.tracks.find((track) => track.name === 'mic')?.seconds ?? null,
    audio: manifest.audio,
    words: wordCount([snapshot.summary, snapshot.notes, ...snapshot.transcript.map((line) => line.text)].join(' ')),
    exportHash: manifest.exportHash,
    indexKey: manifest.updatedAt,
    tags: snapshot.tags,
    tracks: manifest.tracks.map((track) => ({ name: track.name, sampleRate: track.sampleRate, seconds: track.seconds })),
    passes: manifest.passes.map((pass) => ({ id: pass.id, kind: pass.kind, model: pass.model, createdAt: pass.createdAt })),
    speakers: snapshot.speakers.map((speaker) => ({
      cluster: speaker.id,
      name: speaker.name,
      personId: speaker.personId,
      confirmed: speaker.confirmed,
      confidence: speaker.confidence,
      talkSeconds: talk.get(speaker.id)?.seconds ?? 0,
      segments: talk.get(speaker.id)?.segments ?? 0,
      matches: speaker.matches.map((match) => ({ personId: match.personId, score: match.score }))
    })),
    segments: snapshot.transcript.map((segment) => ({
      id: segment.id,
      rawId: segment.rawId,
      start: segment.start,
      end: segment.end,
      cluster: segment.cluster,
      confidence: segment.confidence,
      edited: segment.edited,
      text: segment.text,
      original: segment.original,
      edits: segment.edits.map((edit) => ({
        kind: edit.kind,
        start: edit.start,
        end: edit.end,
        text: edit.kind === 'replace' ? edit.text : null
      }))
    })),
    actionItems: actionItemsOf(snapshot.summary),
    passages: [
      ...(title ? [{ ...base, field: 'title' as const, text: title }] : []),
      ...snapshot.tags.map((tag) => ({ ...base, field: 'tags' as const, text: tag })),
      ...paragraphs(snapshot.summary).map((text) => ({ ...base, field: 'summary' as const, text })),
      ...paragraphs(snapshot.notes).map((text) => ({ ...base, field: 'notes' as const, text })),
      ...snapshot.transcript
        .filter((line) => line.text.trim())
        .map((line) => ({
          field: 'transcript' as const,
          segmentId: line.id,
          cluster: line.cluster,
          start: line.start,
          text: line.text.trim()
        }))
    ],
    chunks: chunksOf(snapshot)
  }
}

import type { SessionSnapshot } from '../../shared/sessionDoc'
import type { SessionManifest } from '../sessionStore'
import type { SessionRecord } from './protocol'

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
    ]
  }
}

import { z } from 'zod'
import type { SpeakerEntry, TranscriptSegment } from './sessionDoc'

/**
 * The parts of a session that "Send to…" can include. The first five are the headings the
 * meeting notes are written under (`renderNotes` in src/main/meeting/notesFormat.ts).
 */
export const SEND_PARTS = [
  'summary',
  'sections',
  'decisions',
  'actionItems',
  'openQuestions',
  'notes',
  'transcript'
] as const
export const SendPart = z.enum(SEND_PARTS)
export type SendPart = z.infer<typeof SendPart>

/** The transcript; the notes are ticked in when wanted. */
export const DEFAULT_SEND_PARTS: SendPart[] = ['transcript']

export const SEND_PART_LABEL: Record<SendPart, string> = {
  summary: 'Summary',
  sections: 'Sections',
  decisions: 'Decisions',
  actionItems: 'Action items',
  openQuestions: 'Open questions',
  notes: 'Your notes',
  transcript: 'Transcript'
}

type NotesPart = Exclude<SendPart, 'notes' | 'transcript'>
const NOTES_PARTS: readonly NotesPart[] = ['summary', 'sections', 'decisions', 'actionItems', 'openQuestions']
const BY_HEADING = new Map(NOTES_PARTS.map((part) => [SEND_PART_LABEL[part], part]))

/**
 * The generated notes split under their headings. Text before any heading (notes from before
 * the headings, or typed by hand) counts as the summary. An empty list, written `- None`, is
 * no content.
 */
export function splitNotes(summary: string): Partial<Record<NotesPart, string>> {
  const lines = new Map<NotesPart, string[]>()
  let part: NotesPart = 'summary'
  for (const line of summary.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = BY_HEADING.get(line.trim())
    if (heading) {
      part = heading
      continue
    }
    lines.set(part, [...(lines.get(part) ?? []), line])
  }
  const parts: Partial<Record<NotesPart, string>> = {}
  for (const [key, value] of lines) {
    const text = value.join('\n').trim()
    if (text && text !== '- None') parts[key] = text
  }
  return parts
}

type Session = {
  title: string
  summary: string
  body: string
  transcript: readonly Pick<TranscriptSegment, 'cluster' | 'text'>[]
  speakers: readonly Pick<SpeakerEntry, 'id' | 'name'>[]
}

/** Each part this session has, with its text; in the order they're sent. */
export function sessionParts(session: Session): { part: SendPart; text: string }[] {
  const notes = splitNotes(session.summary)
  const names = new Map(session.speakers.map((speaker) => [speaker.id, speaker.name]))
  const transcript = session.transcript
    .map((line) => `**${line.cluster ? (names.get(line.cluster) ?? 'Speaker') : 'Speaker'}:** ${line.text}`)
    .join('\n\n')
  const texts: Record<SendPart, string> = {
    ...{ summary: '', sections: '', decisions: '', actionItems: '', openQuestions: '' },
    ...notes,
    notes: session.body.trim(),
    transcript
  }
  return SEND_PARTS.map((part) => ({ part, text: texts[part] })).filter(({ text }) => text !== '')
}

/** The session as Markdown: its title, then each included part under its own heading. */
export function sendText(session: Session, include: readonly SendPart[]): string {
  const body = sessionParts(session)
    .filter(({ part }) => include.includes(part))
    .map(({ part, text }) => `## ${SEND_PART_LABEL[part]}\n\n${text}`)
  const title = session.title && session.title !== 'Untitled' ? [`# ${session.title}`] : []
  return [...title, ...body].join('\n\n')
}

import type { SpeakerEntry, TranscriptSegment } from '../../../shared/sessionDoc'

type Session = {
  title: string
  body: string
  summary: string
  transcript: readonly Pick<TranscriptSegment, 'cluster' | 'text'>[]
  speakers: readonly Pick<SpeakerEntry, 'id' | 'name'>[]
}

/**
 * A session as Markdown: the title, the generated notes (summary, sections, action items,
 * questions), the user's own notes and the transcript with who said each line.
 */
export function sessionMarkdown(session: Session): string {
  const names = new Map(session.speakers.map((speaker) => [speaker.id, speaker.name]))
  const lines = session.transcript.map((line) => {
    const name = line.cluster ? (names.get(line.cluster) ?? 'Speaker') : 'Speaker'
    return `**${name}:** ${line.text}`
  })
  const body = [session.summary.trim(), session.body.trim(), lines.join('\n\n')]
    .filter(Boolean)
    .join('\n\n')
  return session.title && session.title !== 'Untitled' ? `# ${session.title}\n\n${body}` : body
}

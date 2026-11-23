// What Lyra writes to the notes folder, mirroring the app's exporters:
// apps/lyra/src/main/sessionStore.ts (exportBody, the .lyra.json sidecar), main/pages.ts
// (serializePage), main/meeting/notesFormat.ts (renderNotes) and docs/SESSION-MODEL.md.
import { presentSpeakers, speakerName } from './speakers'
import { wordCount } from './text'
import { DAY, hms, isoDate } from './time'
import type { DemoState, Line, Session, Settings, Speaker } from './types'

const TRANSCRIPT_DIVIDER = '──── Transcript ────'
const GENERATED_BY = 'Lyra 0.2.0'

export type MeetingNotes = {
  summary: string
  decisions: string[]
  actionItems: { owner: string; task: string; done: boolean }[]
  openQuestions: string[]
}

/** The demo call's notes. Owners follow the speakers' current names. */
export function meetingNotes(speakers: Speaker[], done: boolean[]): MeetingNotes {
  return {
    summary:
      'The Windows installer works, but code signing is waiting on a certificate expected Wednesday. ' +
      'The team plans to ship on Thursday once the signed build has been tested.',
    decisions: ['Ship Thursday if the signed build passes testing.'],
    actionItems: [
      { owner: speakerName(speakers, 'c2'), task: 'Write the release notes tonight', done: done[0] ?? false },
      { owner: speakerName(speakers, 'c3'), task: 'Test the signed build on the old Surface', done: done[1] ?? false }
    ],
    openQuestions: []
  }
}

const list = (items: string[]): string => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- None')

/** Same layout as the app's renderNotes. */
export function renderNotes(notes: MeetingNotes): string {
  return [
    'Summary',
    notes.summary,
    '',
    'Decisions',
    list(notes.decisions),
    '',
    'Action items',
    notes.actionItems.length
      ? notes.actionItems.map((item) => `- [${item.done ? 'x' : ' '}] ${item.owner}: ${item.task}`).join('\n')
      : '- None',
    '',
    'Open questions',
    list(notes.openQuestions)
  ].join('\n')
}

export type ExportContext = Pick<DemoState, 'speakers' | 'lines' | 'doneActions'> & { settings: Settings }

export function summaryOf(session: Session, ctx: ExportContext): string {
  if (!session.meeting) return ''
  return session.summary ?? renderNotes(meetingNotes(ctx.speakers, ctx.doneActions))
}

export const linesOf = (session: Session, ctx: ExportContext): Line[] => (session.meeting ? ctx.lines : [])

export function sessionWords(session: Session, ctx: ExportContext): number {
  const transcript = linesOf(session, ctx).map((line) => line.text).join(' ')
  return wordCount(session.body) + wordCount(summaryOf(session, ctx)) + wordCount(transcript)
}

/** Generated notes, the user's notes, then the transcript under a People line. */
export function exportBody(session: Session, ctx: ExportContext): string {
  const lines = linesOf(session, ctx)
  const summary = summaryOf(session, ctx)
  if (!lines.length && !summary.trim()) return session.body
  const parts = [summary.trim(), session.body.trim()].filter(Boolean)
  if (lines.length) {
    const people = presentSpeakers(ctx.speakers, lines).map((speaker) => speaker.name)
    const rendered = lines.map((line) => `[${hms(line.start)}] ${speakerName(ctx.speakers, line.cluster)}: ${line.text}`)
    parts.push(`${TRANSCRIPT_DIVIDER}\n\nPeople: ${people.join(', ')}\n\n${rendered.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

/** The export file's full text, as serializePage writes it. */
export function exportText(session: Session, ctx: ExportContext): string {
  const body = exportBody(session, ctx)
  const title = session.title.trim()
  if (session.ext === 'txt') return !title || title === 'Untitled' ? `\n${body}` : `${title}\n\n${body}`
  return `---\nid: ${session.id}\ntitle: ${JSON.stringify(title || 'Untitled')}\nupdatedAt: ${new Date(session.editedAt).toISOString()}\n---\n\n${body}`
}

export const metaName = (session: Session): string => `${session.id.replace(/\.(txt|md)$/, '')}.lyra.json`

function retainedUntil(session: Session, settings: Settings): string | null {
  if (settings.retention === 'always') return null
  const days = settings.retention === '7' ? 7 : 30
  return isoDate(session.startedAt + session.seconds * 1000 + days * DAY)
}

/** The `<stem>.lyra.json` sidecar (schema lyra.session/1). */
export function metaJson(session: Session, ctx: ExportContext): string {
  const lines = linesOf(session, ctx)
  const until = retainedUntil(session, ctx.settings)
  const audio =
    ctx.settings.retention === 'none'
      ? []
      : session.tracks.map((track) => ({
          track,
          path: `.sessions/${session.id}/audio/${track}.wav`,
          sampleRate: 16000,
          seconds: session.seconds,
          retainedUntil: until
        }))
  const rawTranscripts = [{ id: 'live', kind: 'live', path: `.sessions/${session.id}/raw/live.json` }]
  if (session.meeting) rawTranscripts.push({ id: 'pass-1', kind: 'diarized', path: `.sessions/${session.id}/raw/pass-1.json` })
  return JSON.stringify(
    {
      schema: 'lyra.session/1',
      id: session.id,
      export: session.id,
      generatedBy: GENERATED_BY,
      editable: false,
      title: session.title.trim() || 'Untitled',
      tags: session.tags,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(session.startedAt + session.seconds * 1000).toISOString(),
      updatedAt: new Date(session.editedAt).toISOString(),
      durationSeconds: session.seconds,
      words: sessionWords(session, ctx),
      audio,
      rawTranscripts,
      speakers: presentSpeakers(ctx.speakers, lines).map((speaker) => {
        const own = lines.filter((line) => line.cluster === speaker.id)
        return {
          id: speaker.id,
          name: speaker.name,
          personId: speaker.personId,
          confirmed: speaker.confirmed,
          confidence: speaker.confidence,
          talkSeconds: Math.round(own.reduce((sum, line) => sum + line.end - line.start, 0)),
          segments: own.length
        }
      }),
      segments: lines.map((line) => ({
        id: line.id,
        start: line.start,
        end: line.end,
        speaker: line.cluster,
        confidence: line.confidence,
        edited: line.text !== line.original,
        text: line.text
      }))
    },
    null,
    2
  )
}

/** The hidden `.sessions/` folder: audio, raw transcript passes and the edit log. */
export function sessionsTree(sessions: Session[], settings: Settings): string {
  const out = ['.sessions/']
  for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    out.push(`  ${session.id}/`, '    session.json')
    if (settings.retention === 'none') out.push('    audio/            deleted after transcription')
    else for (const track of session.tracks) out.push(`    audio/${track}.wav`)
    out.push('    raw/live.json')
    if (session.meeting) out.push('    raw/pass-1.json')
    out.push('    doc.yjs')
  }
  return out.join('\n')
}

/** What the Copy button puts on the clipboard (the app's toMarkdown). */
export function toMarkdown(session: Session, ctx: ExportContext): string {
  const lines = linesOf(session, ctx).map((line) => `**${speakerName(ctx.speakers, line.cluster)}:** ${line.text}`)
  const body = [summaryOf(session, ctx).trim(), session.body.trim(), lines.join('\n\n')].filter(Boolean).join('\n\n')
  return session.title && session.title !== 'Untitled' ? `# ${session.title}\n\n${body}` : body
}

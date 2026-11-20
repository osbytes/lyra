/** Meeting notes: the schema both engines fill, and how notes sit in the note file. */

export type ActionItem = { owner: string; task: string }

export type MeetingNotes = {
  summary: string
  decisions: string[]
  actionItems: ActionItem[]
  openQuestions: string[]
}

/** JSON schema for structured output (Claude) and grammar-constrained decoding (llama.cpp). */
export const NOTES_SCHEMA = {
  type: 'object',
  // Constrained decoding fills fields in this order; extracting the concrete lists before
  // writing the summary makes small local models much less likely to skip them.
  properties: {
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: { type: 'string' }, task: { type: 'string' } },
        required: ['owner', 'task'],
        additionalProperties: false
      }
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' }
  },
  required: ['decisions', 'actionItems', 'openQuestions', 'summary'],
  additionalProperties: false
} as const

export const NOTES_SYSTEM_PROMPT = [
  'You write meeting notes from a transcript. Lines look like "[hh:mm:ss] Name: what they said".',
  'Return:',
  '- decisions: plans, dates, or choices the group settled on ("let\'s ship it Monday",',
  '  "we\'ll go with option B"). Empty only if nothing was settled.',
  '- actionItems: every task someone took on or was asked to do. Phrases like "I will…",',
  '  "I can take that", "I\'ll send…", or "can you…" are action items. owner is the speaker',
  '  name exactly as written (the one who will do it), or "Unassigned". task is a short',
  '  imperative ("Send the budget draft to finance").',
  '- openQuestions: questions raised but not answered. Empty if none.',
  '- summary: 3-5 plain sentences on what the meeting covered and concluded.',
  'Use only what the transcript says. Be brief.'
].join('\n')

/** Separates generated notes (above) from the labeled transcript (below) in the note body. */
export const TRANSCRIPT_DIVIDER = '──── Transcript ────'

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** Validates model output; throws if it doesn't match the schema. */
export function parseNotes(value: unknown): MeetingNotes {
  if (!value || typeof value !== 'object') throw new Error('Notes were not an object')
  const raw = value as Record<string, unknown>
  const items = raw.actionItems
  if (
    typeof raw.summary !== 'string' ||
    !isStringArray(raw.decisions) ||
    !isStringArray(raw.openQuestions) ||
    !Array.isArray(items)
  ) {
    throw new Error('Notes did not match the expected shape')
  }
  const actionItems = items.flatMap((item: unknown): ActionItem[] => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    return typeof entry.task === 'string'
      ? [{ owner: typeof entry.owner === 'string' ? entry.owner : 'Unassigned', task: entry.task }]
      : []
  })
  return {
    summary: raw.summary.trim(),
    decisions: raw.decisions.map((d) => d.trim()).filter(Boolean),
    actionItems,
    openQuestions: raw.openQuestions.map((q) => q.trim()).filter(Boolean)
  }
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None'
}

/** Plain text that reads well in both .txt and .md files. */
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
      ? notes.actionItems.map((item) => `- [ ] ${item.owner}: ${item.task}`).join('\n')
      : '- None',
    '',
    'Open questions',
    list(notes.openQuestions)
  ].join('\n')
}

/** Splits a meeting body into its notes section (may be empty) and its transcript. */
export function splitNotes(body: string): { notes: string; transcript: string } {
  const index = body.indexOf(TRANSCRIPT_DIVIDER)
  if (index === -1) return { notes: '', transcript: body }
  return {
    notes: body.slice(0, index).trim(),
    transcript: body.slice(index + TRANSCRIPT_DIVIDER.length).replace(/^\s+/, '')
  }
}

export function withNotes(body: string, notes: string): string {
  const { transcript } = splitNotes(body)
  return `${notes}\n\n${TRANSCRIPT_DIVIDER}\n\n${transcript}`
}

/** Splits a long transcript at line boundaries into chunks of at most `maxChars`. */
export function chunkTranscript(transcript: string, maxChars: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of transcript.split('\n')) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current.trim()) chunks.push(current)
  return chunks
}

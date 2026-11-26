/**
 * How every notes writer turns a transcript into notes, whatever its context size.
 *
 * A short meeting that fits is one call. A long one (or one too big for the model) is cut into
 * sections by topic (notesSections.ts) and read in order, one call per section, each with a
 * short recap of the sections before it: the recap keeps references across sections straight,
 * which plain map-reduce loses (Chang et al., "BooookScore", 2024, on incremental updating vs.
 * hierarchical merging). Action items get a call of their own on the same text: a small model
 * asked for everything at once files them as decisions or skips them. Decisions, action items and open questions are combined in code, not
 * by another model call, so a small model can't drop them while merging. Only the meeting's
 * summary is written from the sections' summaries, which are short enough to fit even a 4k
 * context; past that they are summarized in groups first. Pure: the model is the `ask` callback.
 */
import type { z } from 'zod'
import {
  fitText,
  lineText,
  overviewPrompt,
  sectionLine,
  sectionPrompt,
  transcriptPrompt,
  type TokenCounter
} from './notesChunks'
import {
  ACTION_SYSTEM_PROMPT,
  ActionItemsFound,
  cleanTitle,
  NOTES_SYSTEM_PROMPT,
  NotesDraft,
  OVERVIEW_SYSTEM_PROMPT,
  OverviewNotes,
  SECTION_SYSTEM_PROMPT,
  SectionNotes,
  tidyNotes,
  type ActionItem,
  type MeetingNotes,
  type NoteSection,
  type NotesLine,
  type WrittenNotes
} from './notesFormat'
import { splitSections } from './notesSections'

/**
 * One model call: the system prompt, the shape to answer in (a writer constrains decoding to
 * it, or asks for it as structured output), its name for providers that want one, the user
 * message, and whether it's the run's last call (a writer can unload its model after it).
 */
export type NotesCall = { system: string; schema: z.ZodObject; name: string; prompt: string; final: boolean }

/** Answers one call; the pipeline checks the answer against `call.schema` itself. */
export type NotesAsk = (call: NotesCall) => Promise<unknown>

/**
 * The pipeline's version, recorded with each session's notes (`NotesRun`). Bump it when a change
 * would make old notes worth rewriting (better items, a new part of the notes): Settings then
 * offers to rewrite the untouched notes made before it. History: 1, one call or map-reduce;
 * 2, topic sections with a recap, and action items in a call of their own.
 */
export const NOTES_PIPELINE = 2

/**
 * A meeting this long gets sections even when it fits one call: an hour of notes reads better
 * in chapters, and one call over an hour of talk misses things, most of all on a small model.
 */
export const SECTION_AFTER_SECONDS = 20 * 60
/** The recap of earlier sections stays small: it's context, not material for these notes. */
const RECAP_TOKENS = 300
/** Sections the recap goes back: enough to follow a thread, not the whole meeting again. */
const RECAP_SECTIONS = 3
/** Duplicate items share at least this much of their words (Jaccard), in any order. */
const SAME_ITEM = 0.8
/** An action item whose quote shares less than this of its words with the text was made up. */
const QUOTED = 0.5

export type WriteNotesOptions = {
  lines: NotesLine[]
  /** Tokens the user message may take: the context minus the system prompt and the answer. */
  budget: number
  count: TokenCounter
  ask: NotesAsk
  signal?: AbortSignal | undefined
  /** Calls done of those planned, after each one (a long meeting takes many). */
  onProgress?: ((done: number, total: number) => void) | undefined
}

function durationOf(lines: NotesLine[]): number {
  const [first] = lines
  const last = lines.at(-1)
  return first && last ? last.end - first.start : 0
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

function wordSet(text: string): Set<string> {
  const words = new Set<string>()
  for (const part of segmenter.segment(text.toLowerCase())) if (part.isWordLike) words.add(part.segment)
  return words
}

/** Whether two items say the same thing: the same words, give or take a few (not a number). */
export function sameItem(a: string, b: string): boolean {
  const left = wordSet(a)
  const right = wordSet(b)
  if (!left.size || !right.size) return a.trim() === b.trim()
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared) >= SAME_ITEM
}

/** Whether `quote` is (close to) words from `text`: small models copy loosely, not freely. */
export function quotedFrom(quote: string, text: string): boolean {
  const words = wordSet(quote)
  if (!words.size) return true
  const said = wordSet(text)
  let found = 0
  for (const word of words) if (said.has(word)) found++
  return found / words.size >= QUOTED
}

/** The action items in `transcript` (one call), keeping only those it can quote. */
async function actionItemsOf(transcript: string, ask: NotesAsk, final: boolean): Promise<ActionItem[]> {
  const answer = ActionItemsFound.parse(
    await ask({
      system: ACTION_SYSTEM_PROMPT,
      schema: ActionItemsFound,
      name: 'action_items',
      prompt: transcriptPrompt(transcript),
      final
    })
  )
  return answer.actionItems
    .filter((item) => quotedFrom(item.quote, transcript))
    .map((item) => ({ owner: item.owner.trim() || 'Unassigned', task: item.task.trim() }))
    .filter((item) => item.task)
}

/** Items in order with later restatements dropped; `group` keeps apart items that only look alike. */
export function uniqueItems<T>(items: T[], text: (item: T) => string, group: (item: T) => string = () => ''): T[] {
  const kept: T[] = []
  for (const item of items) {
    if (!kept.some((other) => group(other) === group(item) && sameItem(text(other), text(item)))) kept.push(item)
  }
  return kept
}

/** The latest sections that fit `room`, oldest first; the latest alone is cut to fit. */
function recapOf(sections: NoteSection[], room: number, count: TokenCounter): string {
  const lines: string[] = []
  let used = 0
  for (const section of sections.slice(-RECAP_SECTIONS).reverse()) {
    const line = sectionLine(section)
    const size = count(line) + 1
    if (used + size > room) {
      if (!lines.length) lines.push(fitText(line, room, count))
      break
    }
    lines.unshift(line)
    used += size
  }
  return lines.join('\n')
}

/** Consecutive items whose overview prompt fits `budget`; at least two per group (unless one is left). */
function groupsToFit(items: NoteSection[], budget: number, count: TokenCounter): NoteSection[][] {
  const overhead = count(overviewPrompt([]))
  const groups: NoteSection[][] = []
  let group: NoteSection[] = []
  let used = overhead
  for (const item of items) {
    const size = count(sectionLine(item)) + 1
    if (group.length >= 2 && used + size > budget) {
      groups.push(group)
      group = []
      used = overhead
    }
    group.push(item)
    used += size
  }
  if (group.length) groups.push(group)
  return groups
}

async function overviewOf(sections: NoteSection[], options: WriteNotesOptions): Promise<string> {
  const { budget, count, ask, signal } = options
  const summarize = async (items: NoteSection[], final: boolean): Promise<string> => {
    signal?.throwIfAborted()
    const prompt = overviewPrompt(items.map(sectionLine))
    const answer = await ask({ system: OVERVIEW_SYSTEM_PROMPT, schema: OverviewNotes, name: 'meeting_summary', prompt, final })
    return OverviewNotes.parse(answer).summary.trim()
  }
  let items = sections
  // Each round groups at least two items into one, so it ends.
  while (items.length > 1 && count(overviewPrompt(items.map(sectionLine))) > budget) {
    const next: NoteSection[] = []
    for (const group of groupsToFit(items, budget, count)) {
      const [first] = group
      const last = group.at(-1)
      if (!first || !last) continue
      if (group.length === 1) next.push(first)
      else {
        const title = group.map((item) => item.title).join('; ')
        next.push({ start: first.start, end: last.end, title, summary: await summarize(group, false) })
      }
    }
    items = next
  }
  return summarize(items, true)
}

/** Notes for a meeting: one call when it's short and fits, else by sections (see above). */
export async function writeNotes(options: WriteNotesOptions): Promise<WrittenNotes> {
  const { lines, budget, count, ask, signal, onProgress } = options
  if (!lines.length) throw new Error('This note has no transcript to summarize')
  const text = lines.map(lineText).join('\n')
  const whole = transcriptPrompt(text)
  const fits = count(whole) <= budget
  const single = async (): Promise<WrittenNotes> => {
    const draft = NotesDraft.parse(
      await ask({ system: NOTES_SYSTEM_PROMPT, schema: NotesDraft, name: 'meeting_notes', prompt: whole, final: false })
    )
    onProgress?.(1, 2)
    const actionItems = await actionItemsOf(text, ask, true)
    onProgress?.(2, 2)
    return { ...tidyNotes({ ...draft, actionItems }), sections: [] }
  }
  if (fits && durationOf(lines) < SECTION_AFTER_SECONDS) return single()

  const recapRoom = Math.min(RECAP_TOKENS, Math.floor(budget / 8))
  const room = Math.max(64, budget - count(sectionPrompt('', 99, 99, 'x')) - recapRoom)
  const parts = splitSections(lines, { room, count })
  if (parts.length < 2 && fits) return single()

  // Two calls per section (notes, then action items) and the overview.
  const total = parts.length * 2 + 1
  const sections: NoteSection[] = []
  const found: MeetingNotes[] = []
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted()
    const [first] = part
    const last = part.at(-1)
    if (!first || !last) continue
    const transcript = part.map(lineText).join('\n')
    const prompt = sectionPrompt(transcript, index + 1, parts.length, recapOf(sections, recapRoom, count))
    const answer = SectionNotes.parse(
      await ask({ system: SECTION_SYSTEM_PROMPT, schema: SectionNotes, name: 'section_notes', prompt, final: false })
    )
    onProgress?.(index * 2 + 1, total)
    signal?.throwIfAborted()
    const notes = tidyNotes({ ...answer, actionItems: await actionItemsOf(transcript, ask, false) })
    onProgress?.(index * 2 + 2, total)
    found.push(notes)
    sections.push({
      start: first.start,
      end: last.end,
      title: cleanTitle(answer.title) ?? `Part ${String(index + 1)}`,
      summary: notes.summary
    })
  }
  const summary = await overviewOf(sections, options)
  onProgress?.(total, total)
  const owner = (item: ActionItem): string => item.owner.toLowerCase()
  return {
    summary,
    decisions: uniqueItems(found.flatMap((notes) => notes.decisions), String),
    actionItems: uniqueItems(found.flatMap((notes) => notes.actionItems), (item) => item.task, owner),
    openQuestions: uniqueItems(found.flatMap((notes) => notes.openQuestions), String),
    sections
  }
}

import { describe, expect, it } from 'vitest'
import { estimateTokens } from './notesChunks'
import { ActionItemsFound, NotesDraft, OverviewNotes, SectionNotes, type NotesLine } from './notesFormat'
import { callKey, quotedFrom, sameItem, uniqueItems, writeNotes, type NotesCall } from './notesPipeline'

const TOPICS = [
  ['budget', 'spending', 'quarter', 'finance', 'invoice', 'forecast'],
  ['hiring', 'candidate', 'interview', 'recruiter', 'offer', 'onboarding'],
  ['release', 'installer', 'changelog', 'testing', 'version', 'rollback']
]

/** `minutes` of talk on each topic in turn, a line every ten seconds. */
function meeting(minutes: number): NotesLine[] {
  const lines: NotesLine[] = []
  for (const topic of TOPICS) {
    for (let i = 0; i < minutes * 6; i++) {
      const start = lines.length * 10
      const words = Array.from({ length: 10 }, (_, at) => topic[(i * 7 + at * 3) % topic.length] ?? '')
      lines.push({ speaker: i % 2 ? 'Ana' : 'Sam', text: `okay so ${words.join(' ')}`, start, end: start + 9 })
    }
  }
  return lines
}

/** `index` counts the earlier calls with the same schema: the second section call is 1. */
type Answer = (call: NotesCall, index: number) => unknown

/** Records every call and answers it in the shape it asks for. */
function recorder(answer: Answer = defaultAnswer): { calls: NotesCall[]; ask: (call: NotesCall) => Promise<unknown> } {
  const calls: NotesCall[] = []
  return {
    calls,
    ask: (call) => {
      const index = calls.filter((other) => other.schema === call.schema).length
      calls.push(call)
      return Promise.resolve(answer(call, index))
    }
  }
}

function defaultAnswer(call: NotesCall, index: number): unknown {
  if (call.schema === OverviewNotes) return { summary: ' The whole meeting. ' }
  if (call.schema === ActionItemsFound) return { actionItems: [] }
  const base = { decisions: [], openQuestions: [], summary: `Part summary ${String(index)}.` }
  return call.schema === SectionNotes ? { ...base, title: `Topic ${String(index)}` } : base
}

describe('writeNotes', () => {
  it('reads a short meeting that fits whole: notes, then its action items', async () => {
    const { calls, ask } = recorder((call, index) =>
      call.schema === ActionItemsFound
        ? {
            actionItems: [
              { quote: 'I will send the deck', owner: 'Sam', task: ' Send the deck ' },
              { quote: 'Ana will buy everyone lunch', owner: 'Ana', task: 'Buy lunch' }
            ]
          }
        : defaultAnswer(call, index)
    )
    const lines: NotesLine[] = [{ speaker: 'Sam', text: 'We ship Friday. I will send the deck.', start: 0, end: 2 }]
    const notes = await writeNotes({ lines, budget: 1000, count: estimateTokens, ask })
    expect(calls.map((call) => [call.schema, call.final])).toEqual([
      [NotesDraft, false],
      [ActionItemsFound, true]
    ])
    expect(calls[1]?.prompt).toContain('Sam: We ship Friday. I will send the deck.')
    expect(notes.sections).toEqual([])
    expect(notes.summary).toBe('Part summary 0.')
    // Nobody said anything about lunch: an item the model can't quote is dropped.
    expect(notes.actionItems).toEqual([{ owner: 'Sam', task: 'Send the deck' }])
  })

  it('reads a long meeting by sections, each with a recap of the ones before', async () => {
    const { calls, ask } = recorder()
    const progress: string[] = []
    const budget = 8000
    const notes = await writeNotes({
      lines: meeting(10),
      budget,
      count: estimateTokens,
      ask,
      onProgress: (done, total) => progress.push(`${String(done)}/${String(total)}`)
    })
    // Three topics: notes and action items for each section, then the summary, the only final call.
    const section = [SectionNotes, ActionItemsFound]
    expect(calls.map((call) => call.schema)).toEqual([...section, ...section, ...section, OverviewNotes])
    expect(calls.map((call) => call.final)).toEqual([false, false, false, false, false, false, true])
    expect(progress).toEqual(['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7'])
    for (const call of calls) expect(estimateTokens(call.prompt)).toBeLessThanOrEqual(budget)
    const notesCalls = calls.filter((call) => call.schema !== ActionItemsFound)
    expect(notesCalls[0]?.prompt).not.toContain('<recap>')
    expect(notesCalls[1]?.prompt).toContain('[0:00] Topic 0: Part summary 0.')
    expect(notesCalls[2]?.prompt).toContain('[10:00] Topic 1: Part summary 1.')
    expect(notesCalls[3]?.prompt).toContain('[20:00] Topic 2: Part summary 2.')
    // The action-item call reads the same part, without the recap.
    expect(calls[1]?.prompt).not.toContain('<recap>')
    expect(calls[1]?.prompt).toContain('budget')
    expect(calls[1]?.prompt).not.toContain('hiring')
    expect(notes.summary).toBe('The whole meeting.')
    expect(notes.sections.map((part) => [part.start, part.end, part.title])).toEqual([
      [0, 599, 'Topic 0'],
      [600, 1199, 'Topic 1'],
      [1200, 1799, 'Topic 2']
    ])
  })

  it("combines the sections' items in code, dropping restatements but not look-alikes", async () => {
    const quote = 'okay so'
    const { ask } = recorder((call, index) => {
      if (call.schema === OverviewNotes) return { summary: 'S' }
      if (call.schema === ActionItemsFound) {
        const found = [
          [{ quote, owner: 'Sam', task: 'Fix the installer' }],
          [
            { quote, owner: 'sam', task: 'Fix the installer.' },
            { quote, owner: 'Ana', task: 'Fix the installer' }
          ]
        ][index]
        return { actionItems: found ?? [] }
      }
      const items = [
        { decisions: ['Ship on May 5'], openQuestions: ['Who owns QA?'] },
        { decisions: ['ship on may 5.', 'Ship on May 6'], openQuestions: [] },
        { decisions: [], openQuestions: ['  '] }
      ][index] ?? { decisions: [], openQuestions: [] }
      return { ...items, summary: 'x', title: '' }
    })
    const notes = await writeNotes({ lines: meeting(10), budget: 8000, count: estimateTokens, ask })
    expect(notes.decisions).toEqual(['Ship on May 5', 'Ship on May 6'])
    expect(notes.actionItems).toEqual([
      { owner: 'Sam', task: 'Fix the installer' },
      { owner: 'Ana', task: 'Fix the installer' }
    ])
    expect(notes.openQuestions).toEqual(['Who owns QA?'])
    // A section the model didn't name is numbered.
    expect(notes.sections.map((part) => part.title)).toEqual(['Part 1', 'Part 2', 'Part 3'])
  })

  it('cuts a short meeting into sections when it is too big for one call', async () => {
    const { calls, ask } = recorder()
    const lines = meeting(5)
    const budget = 1500
    const notes = await writeNotes({ lines, budget, count: estimateTokens, ask })
    expect(notes.sections.length).toBeGreaterThan(1)
    for (const call of calls) expect(estimateTokens(call.prompt)).toBeLessThanOrEqual(budget)
  })

  it('summarizes the sections in groups when even their summaries overflow', async () => {
    const long = 'word '.repeat(150)
    const { calls, ask } = recorder((call, index) =>
      call.schema === OverviewNotes
        ? { summary: `Group ${String(index)}` }
        : call.schema === ActionItemsFound
          ? { actionItems: [] }
          : { decisions: [], openQuestions: [], summary: long, title: 'T' }
    )
    const budget = 600
    await writeNotes({ lines: meeting(10), budget, count: estimateTokens, ask })
    const overviews = calls.filter((call) => call.schema === OverviewNotes)
    expect(overviews.length).toBeGreaterThan(1)
    expect(overviews.filter((call) => call.final)).toHaveLength(1)
    expect(calls.at(-1)?.final).toBe(true)
  })

  it('stops between calls once aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const run = writeNotes({
      lines: meeting(10),
      budget: 8000,
      count: estimateTokens,
      signal: controller.signal,
      ask: (call) => {
        calls += 1
        controller.abort(new Error('stop'))
        return Promise.resolve(defaultAnswer(call, 0))
      }
    })
    await expect(run).rejects.toThrow('stop')
    expect(calls).toBe(1)
  })

  it('refuses an empty transcript', async () => {
    const { ask } = recorder()
    await expect(writeNotes({ lines: [], budget: 100, count: estimateTokens, ask })).rejects.toThrow('no transcript')
  })
})

describe('quotedFrom', () => {
  it('accepts a loose copy of what was said, not words nobody said', () => {
    const said = 'Sam: Sure, I will send the budget draft to finance by Thursday.'
    expect(quotedFrom('I will send the budget draft to finance', said)).toBe(true)
    expect(quotedFrom('I will send the budget draft over to finance', said)).toBe(true)
    expect(quotedFrom('Ana books the offsite venue', said)).toBe(false)
    expect(quotedFrom('', said)).toBe(true)
  })
})

describe('sameItem', () => {
  it('matches restatements, not a different number', () => {
    expect(sameItem('Send the budget to finance', 'send the budget to Finance.')).toBe(true)
    expect(sameItem('Ship on May 5', 'Ship on May 6')).toBe(false)
    expect(uniqueItems(['a b c d e', 'A B C D E', 'f'], String)).toEqual(['a b c d e', 'f'])
  })
})

describe('answers kept from an earlier try', () => {
  it('asks a retry only what the try it replaces had no answer to', async () => {
    const whole = recorder()
    const expected = await writeNotes({ lines: meeting(10), budget: 8000, count: estimateTokens, ask: whole.ask })
    // The first try gets five answers, then the app quits.
    const kept: Record<string, unknown> = {}
    const first = recorder()
    let answered = 0
    const failing = async (call: NotesCall): Promise<unknown> => {
      if (answered === 5) throw new Error('quit')
      answered++
      return first.ask(call)
    }
    const save = (key: string, answer: unknown): void => {
      kept[key] = answer
    }
    await expect(
      writeNotes({ lines: meeting(10), budget: 8000, count: estimateTokens, ask: failing, answers: { known: {}, save } })
    ).rejects.toThrow('quit')
    expect(Object.keys(kept)).toHaveLength(5)

    const retry = recorder()
    const notes = await writeNotes({
      lines: meeting(10),
      budget: 8000,
      count: estimateTokens,
      ask: retry.ask,
      answers: { known: kept, save }
    })
    expect(retry.calls).toHaveLength(whole.calls.length - 5)
    expect(retry.calls.map(callKey)).toEqual(whole.calls.slice(5).map(callKey))
    expect(notes).toEqual(expected)
  })

  it('asks again where a kept answer no longer fits its call', async () => {
    const lines: NotesLine[] = [{ speaker: 'Sam', text: 'We ship Friday.', start: 0, end: 2 }]
    const first = recorder()
    await writeNotes({ lines, budget: 1000, count: estimateTokens, ask: first.ask })
    const [draft] = first.calls
    if (!draft) throw new Error('expected a call')
    const saved: string[] = []
    const retry = recorder()
    await writeNotes({
      lines,
      budget: 1000,
      count: estimateTokens,
      ask: retry.ask,
      answers: { known: { [callKey(draft)]: { summary: 42 } }, save: (key) => saved.push(key) }
    })
    expect(retry.calls.map((call) => call.schema)).toEqual([NotesDraft, ActionItemsFound])
    expect(saved).toEqual(retry.calls.map(callKey))
  })
})

import { describe, expect, it } from 'vitest'
import {
  MeetingNotes,
  TRANSCRIPT_DIVIDER,
  cleanTitle,
  renderNotes,
  splitNotes,
  tidyNotes
} from './notesFormat'

describe('cleanTitle', () => {
  it('drops quotes and a trailing period', () => {
    expect(cleanTitle('  "Q3 budget review."  ')).toBe('Q3 budget review')
  })

  it('reads a slug as words and capitalizes the first', () => {
    expect(cleanTitle('"meeting-planning."')).toBe('Meeting planning')
    expect(cleanTitle('garden_ideas')).toBe('Garden ideas')
  })

  it('collapses whitespace and newlines', () => {
    expect(cleanTitle('Ideas\n for   the garden')).toBe('Ideas for the garden')
  })

  it('cuts a long title at a word, under 80 characters', () => {
    // 20 × "word " is 100 characters; the first 80 end in a space after the 16th word
    const title = cleanTitle('word '.repeat(20))
    expect(title).toBe(`Word${' word'.repeat(15)}`)
    expect(title?.length).toBe(79)
  })

  it('returns null when nothing is left', () => {
    expect(cleanTitle('  ""  ')).toBeNull()
    expect(cleanTitle('...')).toBeNull()
  })
})

describe('tidyNotes', () => {
  it('trims entries, drops empty ones and gives an ownerless task to Unassigned', () => {
    const tidy = tidyNotes({
      summary: ' What we covered. ',
      decisions: [' Ship Monday ', '', '  '],
      actionItems: [
        { owner: '  ', task: ' Send the draft ' },
        { owner: 'Bo', task: '   ' }
      ],
      openQuestions: ['  ']
    })
    expect(tidy).toEqual({
      summary: 'What we covered.',
      decisions: ['Ship Monday'],
      actionItems: [{ owner: 'Unassigned', task: 'Send the draft' }],
      openQuestions: []
    })
  })
})

describe('renderNotes', () => {
  it('writes every section, with "- None" for an empty one', () => {
    const text = renderNotes({
      summary: 'We met.',
      decisions: [],
      actionItems: [{ owner: 'Ana', task: 'Send it' }],
      openQuestions: ['When?'],
      sections: []
    })
    expect(text).toBe(
      [
        'Summary',
        'We met.',
        '',
        'Decisions',
        '- None',
        '',
        'Action items',
        '- [ ] Ana: Send it',
        '',
        'Open questions',
        '- When?'
      ].join('\n')
    )
  })
})

describe('splitNotes', () => {
  it('splits a 0.2 meeting body at the divider', () => {
    const body = `Summary\nWe met.\n\n${TRANSCRIPT_DIVIDER}\n\nAna: hello`
    expect(splitNotes(body)).toEqual({ notes: 'Summary\nWe met.', transcript: 'Ana: hello' })
  })

  it('reads a body without a divider as all transcript', () => {
    expect(splitNotes('Ana: hello')).toEqual({ notes: '', transcript: 'Ana: hello' })
  })

  it('round-trips rendered notes', () => {
    const notes = { summary: 'S', decisions: ['D'], actionItems: [], openQuestions: [], sections: [] }
    const body = `${renderNotes(notes)}\n\n${TRANSCRIPT_DIVIDER}\n\nAna: hi`
    expect(splitNotes(body).notes).toBe(renderNotes(notes))
  })
})

describe('MeetingNotes', () => {
  it('refuses a reply with fields it does not know or without one it needs', () => {
    const notes = { summary: 'S', decisions: [], actionItems: [], openQuestions: [] }
    expect(MeetingNotes.safeParse(notes).success).toBe(true)
    expect(MeetingNotes.safeParse({ ...notes, extra: 1 }).success).toBe(false)
    expect(MeetingNotes.safeParse({ summary: 'S' }).success).toBe(false)
    expect(
      MeetingNotes.safeParse({ ...notes, actionItems: [{ owner: 'A', task: 'B', due: 'C' }] }).success
    ).toBe(false)
  })
})

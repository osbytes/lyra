import { describe, expect, it } from 'vitest'
import { sendText, sessionParts, splitNotes } from './sendParts'

const summary = [
  'Summary',
  'Ship the dock first.',
  '',
  'Sections',
  '- 0:00 The dock: what people see first',
  '',
  'Decisions',
  '- None',
  '',
  'Action items',
  '- [ ] Dana: port tokens',
  '',
  'Open questions',
  '- Does the meeting button need a shortcut?'
].join('\n')

const session = {
  title: 'Design review',
  summary,
  body: 'Ask about the folder chip.',
  transcript: [
    { cluster: 'c0', text: 'Start with the dock.' },
    { cluster: null, text: 'Agreed.' }
  ],
  speakers: [{ id: 'c0', name: 'Dana' }]
}

describe('splitNotes', () => {
  it('splits the notes under their headings and drops empty lists', () => {
    expect(splitNotes(summary)).toEqual({
      summary: 'Ship the dock first.',
      sections: '- 0:00 The dock: what people see first',
      actionItems: '- [ ] Dana: port tokens',
      openQuestions: '- Does the meeting button need a shortcut?'
    })
  })

  it('counts text with no heading as the summary', () => {
    expect(splitNotes('Just a paragraph.\r\n\r\nAction items\r\n- [ ] Sam: check')).toEqual({
      summary: 'Just a paragraph.',
      actionItems: '- [ ] Sam: check'
    })
  })
})

describe('sessionParts', () => {
  it('lists only the parts the session has, in send order', () => {
    expect(sessionParts(session).map(({ part }) => part)).toEqual([
      'summary',
      'sections',
      'actionItems',
      'openQuestions',
      'notes',
      'transcript'
    ])
  })
})

describe('sendText', () => {
  it('puts each included part under its heading, after the title', () => {
    expect(sendText(session, ['actionItems', 'notes', 'transcript'])).toBe(
      '# Design review\n\n' +
        '## Action items\n\n- [ ] Dana: port tokens\n\n' +
        '## Your notes\n\nAsk about the folder chip.\n\n' +
        '## Transcript\n\n**Dana:** Start with the dock.\n\n**Speaker:** Agreed.'
    )
  })

  it('is just the title when nothing is included', () => {
    expect(sendText(session, [])).toBe('# Design review')
  })
})

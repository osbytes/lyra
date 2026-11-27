import { describe, expect, it } from 'vitest'
import { sessionMarkdown } from './sessionMarkdown'

const session = {
  title: 'Design review',
  summary: 'Summary\nShip the dock first.\n\nAction items\n- [ ] Dana: port tokens',
  body: 'Ask about the folder chip.',
  transcript: [
    { cluster: 'c0', text: 'Start with the dock.' },
    { cluster: null, text: 'Agreed.' }
  ],
  speakers: [{ id: 'c0', name: 'Dana' }]
}

describe('sessionMarkdown', () => {
  it('puts the title, notes and transcript in that order', () => {
    expect(sessionMarkdown(session)).toBe(
      '# Design review\n\n' +
        'Summary\nShip the dock first.\n\nAction items\n- [ ] Dana: port tokens\n\n' +
        'Ask about the folder chip.\n\n' +
        '**Dana:** Start with the dock.\n\n**Speaker:** Agreed.'
    )
  })

  it('drops an untitled heading and empty parts', () => {
    expect(sessionMarkdown({ ...session, title: 'Untitled', summary: '  ', transcript: [] })).toBe(
      'Ask about the folder chip.'
    )
  })
})

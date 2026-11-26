import { describe, expect, it } from 'vitest'
import { parseClock, summarySections } from './summarySections'

describe('parseClock', () => {
  it('reads minutes and hours', () => {
    expect(parseClock('0:05')).toBe(5)
    expect(parseClock('12:40')).toBe(760)
    expect(parseClock('1:02:03')).toBe(3723)
  })

  it('rejects anything else', () => {
    expect(parseClock('12')).toBeNull()
    expect(parseClock('1:75')).toBeNull()
    expect(parseClock('Dana:')).toBeNull()
  })
})

describe('summarySections', () => {
  const summary = [
    'Summary',
    'The team planned the launch.',
    '',
    'Sections',
    '- 0:00 Launch plan: Dates were set.',
    '- 21:15 Hiring: Two roles opened: design and QA.',
    '- 1:02:03 Wrap up',
    '',
    'Decisions',
    '- 0:30 is not a section',
    '',
    'Action items',
    '- [ ] Dana: port tokens'
  ].join('\n')

  it('reads each section under the heading, and nothing after it', () => {
    expect(summarySections(summary)).toEqual([
      { start: 0, title: 'Launch plan', summary: 'Dates were set.' },
      { start: 1275, title: 'Hiring', summary: 'Two roles opened: design and QA.' },
      { start: 3723, title: 'Wrap up', summary: '' }
    ])
  })

  it('finds none in a summary without sections', () => {
    expect(summarySections('Summary\nShort call.\n\nDecisions\n- None')).toEqual([])
  })
})

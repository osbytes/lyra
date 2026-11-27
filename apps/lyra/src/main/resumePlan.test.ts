import { describe, expect, it } from 'vitest'
import { newWords, resumeSpans, spanTracks } from './resumePlan'

describe('resumeSpans', () => {
  it('transcribes each take once, over every track from its earliest mark to its latest end', () => {
    const spans = resumeSpans([
      { take: 100, track: 'mic', start: 120, end: 125 },
      { take: 0, track: 'mic', start: 40, end: 60 },
      { take: 0, track: 'system', start: 38.5, end: 60 }
    ])
    expect(spans.map(({ take, from, to }) => ({ take, from, to }))).toEqual([
      { take: 0, from: 38.5, to: 60 },
      { take: 100, from: 120, to: 125 }
    ])
    expect(spans.map(spanTracks)).toEqual([['mic', 'system'], ['mic']])
  })
})

describe('newWords', () => {
  const marks = [
    { take: 0, track: 'mic' as const, start: 40, end: 60 },
    { take: 0, track: 'system' as const, start: 38.5, end: 60 }
  ]

  it('keeps only the words its track had not transcribed yet', () => {
    const chunk = {
      track: 'mic' as const,
      start: 38.5,
      end: 45,
      words: [
        { text: ' kept', start: 38.6, end: 39 },
        { text: ' before', start: 39.9, end: 40.2 },
        { text: ' new', start: 40, end: 40.4 },
        { text: ' words', start: 41, end: 41.5 }
      ]
    }
    expect(newWords(chunk, marks)?.words.map((word) => word.text)).toEqual([' new', ' words'])
  })

  it('drops a chunk with nothing new, and words of a track with no mark', () => {
    const early = {
      track: 'mic' as const,
      start: 38.5,
      end: 39.5,
      words: [{ text: ' old', start: 38.6, end: 39 }]
    }
    expect(newWords(early, marks)).toBeNull()
    expect(
      newWords(
        { ...early, track: 'system', start: 70, words: [{ text: ' late', start: 70, end: 71 }] },
        marks
      )
    ).toBeNull()
  })
})

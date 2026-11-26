import { describe, expect, it } from 'vitest'
import { estimateTokens, lineText } from './notesChunks'
import type { NotesLine } from './notesFormat'
import { splitSections, topicShifts, wordsOf } from './notesSections'

/** A fixed pseudo-random sequence, so the generated talk is the same on every run. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const FILLER = ['okay', 'so', 'we', 'think', 'that', 'really', 'yeah', 'right', 'maybe', 'just']
const TOPICS = [
  ['budget', 'spending', 'quarter', 'finance', 'invoice', 'forecast', 'costs', 'revenue'],
  ['hiring', 'candidate', 'interview', 'recruiter', 'offer', 'engineer', 'onboarding', 'salary'],
  ['release', 'installer', 'changelog', 'bug', 'testing', 'version', 'deploy', 'rollback']
]

/** `minutes` of talk per topic, a line every ten seconds from two people, topics in order. */
function meeting(minutes: number): NotesLine[] {
  const next = random(7)
  const pick = (words: string[]): string => words[Math.floor(next() * words.length)] ?? ''
  const lines: NotesLine[] = []
  for (const topic of TOPICS) {
    for (let i = 0; i < minutes * 6; i++) {
      const start = lines.length * 10
      const words = Array.from({ length: 12 }, (_, at) => (at % 3 === 0 ? pick(topic) : pick(FILLER)))
      lines.push({ speaker: lines.length % 2 ? 'Ana' : 'Sam', text: words.join(' '), start, end: start + 9 })
    }
  }
  return lines
}

describe('splitSections', () => {
  it('cuts where the topic changes', () => {
    // Three ten-minute topics: the cuts belong at 10:00 and 20:00.
    const sections = splitSections(meeting(10), { room: 6000, count: estimateTokens })
    expect(sections.map((section) => section[0]?.start)).toEqual([0, 600, 1200])
  })

  it('keeps every line, in order, with each section within the room', () => {
    const lines = meeting(10)
    const room = 800
    const sections = splitSections(lines, { room, count: estimateTokens })
    expect(sections.length).toBeGreaterThan(3)
    expect(sections.flat()).toEqual(lines)
    for (const section of sections) {
      expect(section.reduce((sum, line) => sum + estimateTokens(lineText(line)) + 1, 0)).toBeLessThanOrEqual(room)
    }
  })

  it('cuts lines that have no times by their length', () => {
    const lines = meeting(10).map((line) => ({ ...line, start: 0, end: 0 }))
    const sections = splitSections(lines, { room: 6000, count: estimateTokens })
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.flat()).toEqual(lines)
  })

  it('splits a line too long for a section, sharing out its time', () => {
    const line: NotesLine = { speaker: 'Sam', text: 'budget '.repeat(3000).trim(), start: 0, end: 600 }
    const sections = splitSections([line], { room: 500, count: estimateTokens })
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      expect(section.reduce((sum, part) => sum + estimateTokens(lineText(part)) + 1, 0)).toBeLessThanOrEqual(500)
    }
    expect(sections.flat().map((part) => part.text).join(' ')).toBe(line.text)
    expect(sections.at(-1)?.at(-1)?.end).toBeCloseTo(600)
  })

  it('returns nothing for no lines', () => {
    expect(splitSections([], { room: 100, count: estimateTokens })).toEqual([])
  })
})

describe('topicShifts', () => {
  it('scores the deepest dip 1 and a steady stretch 0', () => {
    const a = new Map([['budget', 1]])
    const b = new Map([['hiring', 1]])
    const shifts = topicShifts([a, a, a, b, b, b])
    expect(shifts[0]).toBe(0)
    expect(shifts[3]).toBe(1)
    expect(Math.max(...shifts.filter((_, gap) => gap !== 3))).toBeLessThan(1)
  })
})

describe('wordsOf', () => {
  it('finds words in languages written without spaces', () => {
    expect(wordsOf('我们讨论预算').length).toBeGreaterThan(1)
    expect(wordsOf('We ship v2 on 5 May.')).toEqual(['we', 'ship', 'v2', 'on', 'may'])
  })
})

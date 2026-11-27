import { describe, expect, it } from 'vitest'
import { dailyRecording, durationLabel, greeting, topTags, weekStats } from './dashboard'

// Local times, so the tests mean the same in every time zone.
const now = new Date(2026, 10, 26, 15, 0) // Thu 26 Nov 2026
const at = (day: number, hour = 10): string => new Date(2026, 10, day, hour).toISOString()
const session = (day: number, seconds: number | null, speakers: number, tags: string[] = []) => ({
  id: `${String(day)}-${String(seconds)}`,
  startedAt: at(day),
  seconds,
  speakers,
  tags
})

const sessions = [
  session(26, 3600, 4, ['q4']), // today, a meeting
  session(24, 120, 1), // this week, a dictation
  session(20, null, 0, ['q4', 'ideas']), // this week (the 20th is six days back), nothing recorded
  session(19, 1800, 2, ['ideas']), // last week, a meeting
  session(10, 600, 3) // too old for either week
]

describe('weekStats', () => {
  it('counts the last seven days against the seven before', () => {
    expect(weekStats(sessions, now)).toEqual({
      current: { sessions: 3, seconds: 3720, meetings: 1, dictations: 1 },
      previous: { sessions: 1, seconds: 1800, meetings: 1, dictations: 0 }
    })
  })
})

describe('dailyRecording', () => {
  it('sums each day, oldest first and today last', () => {
    const days = dailyRecording(sessions, 7, now)
    expect(days).toHaveLength(7)
    expect(days.map((day) => day.seconds)).toEqual([0, 0, 0, 0, 120, 0, 3600])
    expect(days.map((day) => day.sessions)).toEqual([1, 0, 0, 0, 1, 0, 1])
    expect(days[6]?.date.getDate()).toBe(26)
  })
})

describe('topTags', () => {
  it('ranks tags by use, then by name', () => {
    expect(topTags(sessions, 5)).toEqual([
      ['ideas', 2],
      ['q4', 2]
    ])
    expect(topTags(sessions, 1)).toEqual([['ideas', 2]])
  })
})

describe('durationLabel', () => {
  it('says a duration the way a person would', () => {
    expect(durationLabel(45)).toBe('45s')
    expect(durationLabel(34 * 60)).toBe('34m')
    expect(durationLabel(3767)).toBe('1h 03m')
  })
})

describe('greeting', () => {
  it('follows the time of day', () => {
    expect(greeting(new Date(2026, 0, 1, 9))).toBe('Good morning')
    expect(greeting(new Date(2026, 0, 1, 13))).toBe('Good afternoon')
    expect(greeting(new Date(2026, 0, 1, 20))).toBe('Good evening')
  })
})

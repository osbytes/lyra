import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { normalize, editDistance, hungarian, wer, cpWer, der, score } = require('./metrics.cjs')

const seg = (speaker, start, end, text = '') => ({ speaker, start, end, text })
const meeting = (...segments) => ({ segments })

describe('normalize', () => {
  it('lowercases, drops punctuation and fillers, and splits hyphenated words', () => {
    expect(normalize('Um, Hello—World! It’s mm-hmm e-mail')).toEqual(['hello', 'world', "it's", 'e', 'mail'])
  })

  it('strips quotes around a word but keeps an apostrophe inside one', () => {
    expect(normalize("'quoted' don't")).toEqual(['quoted', "don't"])
  })
})

describe('editDistance', () => {
  it('counts substitutions, insertions and deletions of words', () => {
    expect(editDistance(['a', 'b'], [])).toBe(2)
    expect(editDistance([], ['a'])).toBe(1)
    // b→x, d inserted
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2)
  })
})

describe('hungarian', () => {
  it('finds the cheapest assignment', () => {
    // 1 + 2 + 2 = 5; every other assignment costs 6 or more
    expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2])
  })
})

describe('wer', () => {
  it('scores one substitution and one deletion over six reference words', () => {
    const result = wer(meeting(seg('A', 0, 1, 'the cat sat on the mat')), meeting(seg('X', 0, 1, 'the cat sit on mat')))
    expect(result).toEqual({ errors: 2, words: 6, rate: 2 / 6 })
  })

  it('ignores who spoke', () => {
    const ref = meeting(seg('A', 0, 1, 'hello there'), seg('B', 1, 2, 'general kenobi'))
    const hyp = meeting(seg('X', 0, 2, 'hello there general kenobi'))
    expect(wer(ref, hyp).errors).toBe(0)
  })
})

describe('cpWer', () => {
  it('matches speakers whatever the hypothesis calls them', () => {
    const ref = meeting(seg('A', 0, 1, 'hello there'), seg('B', 1, 2, 'good morning'))
    const hyp = meeting(seg('X', 0, 1, 'good morning'), seg('Y', 1, 2, 'hello there'))
    expect(cpWer(ref, hyp)).toEqual({ errors: 0, words: 4, rate: 0, mapping: { A: 'Y', B: 'X' } })
  })

  it('counts words given to the wrong speaker, which plain WER does not', () => {
    const ref = meeting(seg('A', 0, 4, 'a b c d'), seg('B', 4, 6, 'e f'))
    const hyp = meeting(seg('X', 0, 5, 'a b c d e'), seg('Y', 5, 6, 'f'))
    expect(wer(ref, hyp).errors).toBe(0)
    // A→X: "e" inserted; B→Y: "e" deleted
    expect(cpWer(ref, hyp)).toMatchObject({ errors: 2, words: 6, mapping: { A: 'X', B: 'Y' } })
  })

  it('counts every word of an unmatched reference speaker as deleted', () => {
    const ref = meeting(seg('A', 0, 1, 'one two three'), seg('B', 1, 2, 'four five'))
    const hyp = meeting(seg('X', 0, 2, 'one two three'))
    expect(cpWer(ref, hyp)).toEqual({ errors: 2, words: 5, rate: 0.4, mapping: { A: 'X' } })
  })

  it('counts every word of an extra hypothesis speaker as inserted', () => {
    const ref = meeting(seg('A', 0, 1, 'one two'))
    const hyp = meeting(seg('X', 0, 1, 'one two'), seg('Y', 1, 2, 'extra words here'))
    expect(cpWer(ref, hyp)).toEqual({ errors: 3, words: 2, rate: 1.5, mapping: { A: 'X' } })
  })
})

describe('der', () => {
  const noCollar = { collar: 0 }

  it('is zero for the right turns under other names', () => {
    const result = der(meeting(seg('A', 0, 2), seg('B', 2, 4)), meeting(seg('X', 0, 2), seg('Y', 2, 4)), noCollar)
    expect(result).toEqual({ rate: 0, missed: 0, falseAlarm: 0, confusion: 0, scoredSeconds: 4 })
  })

  it('counts missed speech', () => {
    // 1 of 4 reference seconds has no hypothesis speaker
    const result = der(meeting(seg('A', 0, 4)), meeting(seg('X', 0, 3)), noCollar)
    expect(result).toMatchObject({ rate: 0.25, missed: 0.25, falseAlarm: 0, confusion: 0 })
  })

  it('counts false alarms against reference time', () => {
    // an extra speaker for 1 s, over 2 s of reference speech
    const result = der(meeting(seg('A', 0, 2)), meeting(seg('X', 0, 2), seg('Y', 2, 3)), noCollar)
    expect(result).toMatchObject({ rate: 0.5, missed: 0, falseAlarm: 0.5, confusion: 0 })
  })

  it('counts confusion when two speakers are merged into one', () => {
    // one hypothesis speaker maps to A or B; the other's 2 s are confused
    const result = der(meeting(seg('A', 0, 2), seg('B', 2, 4)), meeting(seg('X', 0, 4)), noCollar)
    expect(result).toMatchObject({ rate: 0.5, missed: 0, falseAlarm: 0, confusion: 0.5 })
  })

  it('scores overlapped speech: one of two overlapping speakers missed', () => {
    const result = der(meeting(seg('A', 0, 2), seg('B', 0, 2)), meeting(seg('X', 0, 2)), noCollar)
    expect(result).toMatchObject({ rate: 0.5, missed: 0.5, confusion: 0, scoredSeconds: 4 })
  })

  it('skips a collar around each reference boundary', () => {
    // 2 s of speech minus 0.25 s inside each end
    expect(der(meeting(seg('A', 1, 3)), meeting(seg('X', 1, 3))).scoredSeconds).toBe(1.5)
  })

  it('maps speakers by overlapping time, not by order of appearance', () => {
    // X talks over most of B's time and Y over A's: the best mapping is A→Y, B→X
    const ref = meeting(seg('A', 0, 1), seg('B', 1, 4))
    const hyp = meeting(seg('X', 0, 0.5), seg('X', 1, 4), seg('Y', 0.5, 1))
    // A's first 0.5 s is labeled X, which is B's speaker: confusion 0.5 of 4 s
    expect(der(ref, hyp, noCollar)).toMatchObject({ confusion: 0.125, missed: 0, falseAlarm: 0 })
  })
})

describe('score', () => {
  it('counts speakers on both sides', () => {
    const result = score(meeting(seg('A', 0, 1, 'hi'), seg('B', 1, 2, 'yo')), meeting(seg('X', 0, 2, 'hi yo')))
    expect(result.refSpeakers).toBe(2)
    expect(result.hypSpeakers).toBe(1)
    // X matches one of them with "yo" or "hi" extra; the other's word is deleted
    expect(result.cpWer.errors).toBe(2)
  })
})

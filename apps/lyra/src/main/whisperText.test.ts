import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '../shared/types'
import { isHallucination, isLoop, isPromptEcho, normalize, wordsFromTokens } from './whisperText'

/** Token rows as the addon returns them with `max_len: 1`, 100 ms apart. */
function rows(...tokens: string[]): { transcription: string[][] } {
  const stamp = (ms: number): string => `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  return { transcription: tokens.map((text, index) => [stamp(index * 100), stamp(index * 100 + 100), text]) }
}

const text = (words: TranscriptWord[]): string => words.map((word) => word.text).join('')

function words(sentence: string): TranscriptWord[] {
  return sentence.split(' ').map((word, index) => ({ text: ` ${word}`, start: index * 0.3, end: index * 0.3 + 0.3 }))
}

describe('wordsFromTokens', () => {
  it('joins word pieces and punctuation, and drops annotations', () => {
    const result = wordsFromTokens(rows(' Hello', ',', ' wor', 'ld', ' [', 'BL', 'ANK', '_', 'AUD', 'IO', ']', ' again', '.'))
    expect(result.map((word) => word.text)).toEqual([' Hello,', ' world', ' again.'])
    expect(text(wordsFromTokens(rows(' *', 'Gun', 'shot', '*', ' yes')))).toBe(' yes')
  })

  it('keeps the rest of the chunk after a stray bracket', () => {
    const tokens = [' the', ' range', ' (', 'one', ' to', ' ten', ' and', ' then', ' we', ' went', ' home', ' after', ' that', ' and', ' slept']
    const result = text(wordsFromTokens(rows(...tokens)))
    expect(result).toBe(' the range (one to ten and then we went home after that and slept')
  })

  it('still drops a short annotation cut off at the end', () => {
    expect(text(wordsFromTokens(rows(' okay', ' (', 'music')))).toBe(' okay')
  })

  it('splits spaceless scripts per token, without adding spaces', () => {
    const result = wordsFromTokens(rows(' 我们', '今天', '开会', '。', '明天', '见'))
    expect(result.map((word) => word.text)).toEqual([' 我们', '今天', '开会。', '明天', '见'])
    expect(text(result)).toBe(' 我们今天开会。明天见')
    expect(result[1]?.start).toBe(0.1)
    const japanese = wordsFromTokens(rows(' こんにちは', 'ありがとう'))
    expect(japanese).toHaveLength(2)
  })
})

describe('isLoop', () => {
  it('flags a sentence repeated through the chunk', () => {
    expect(isLoop("I'm very impressed. I'm very impressed. I'm very impressed.")).toBe(true)
  })

  it('keeps a short reply of one repeated word', () => {
    expect(isLoop('No. No. No.')).toBe(false)
    expect(isLoop('Okay. Okay. Okay. Okay.')).toBe(false)
    expect(isLoop(Array.from({ length: 10 }, () => 'Okay.').join(' '))).toBe(true)
  })
})

describe('isPromptEcho', () => {
  const prompt = 'Weekly sync. We looked at the numbers and everything checks out. Sounds good to me.'

  it('keeps a phrase said again at a natural pace', () => {
    expect(isPromptEcho(normalize('Sounds good to me.'), prompt, 1.4)).toBe(false)
  })

  it('keeps a phrase from earlier in the context, not its tail', () => {
    expect(isPromptEcho(normalize('everything checks out'), prompt, 0.4)).toBe(false)
    expect(isPromptEcho(normalize('Weekly sync'), prompt, 0.2)).toBe(false)
  })

  it('drops a long copy of the tail, or a short one the audio cannot hold', () => {
    expect(isPromptEcho(normalize('We looked at the numbers and everything checks out. Sounds good to me.'), prompt, 6)).toBe(true)
    expect(isPromptEcho(normalize('Sounds good to me.'), prompt, 0.4)).toBe(true)
    expect(isPromptEcho(normalize('Sounds good to me.'), prompt, 20)).toBe(true)
  })

  it('needs the echo to start on a word', () => {
    expect(isPromptEcho(normalize('ounds good to me'), prompt, 0.2)).toBe(false)
  })
})

describe('isHallucination', () => {
  it('drops stock phrases and loops', () => {
    expect(isHallucination(words('Thanks for watching!'), '', 2)).toBe(true)
    expect(isHallucination(words('Bye. Bye now. Bye now. Bye now.'), '', 3)).toBe(true)
  })

  it('keeps real replies', () => {
    expect(isHallucination(words('No. No. No.'), '', 1.5)).toBe(false)
    expect(isHallucination(words('Sounds good to me.'), 'Sounds good to me.', 1.5)).toBe(false)
    expect(isHallucination(words('Yes.'), 'Yes.', 1)).toBe(false)
  })
})

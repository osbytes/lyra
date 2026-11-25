import { z } from 'zod'
import type { TranscriptWord } from '../shared/types'
import hallucinationList from './data/hallucinations.json'

/**
 * Turning whisper.cpp's token rows into words, and telling real speech from what Whisper invents.
 * No Electron or native addon here, so both are unit-tested (`whisperText.test.ts`).
 */

function seconds(stamp: unknown): number {
  const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(stamp))
  if (!match) return 0
  const [, h = 0, m = 0, s = 0, ms = 0] = match.map(Number)
  return h * 3600 + m * 60 + s + ms / 1000
}

/**
 * An annotation is a few tokens: "[BLANK_AUDIO]" is about seven, "(speaking in foreign language)"
 * about six. A bracket or star still open after this many tokens wasn't one (a stray "(" or a
 * "*" in "5 * 3"), so its tokens are words after all and the rest of the chunk is read normally.
 */
const MAX_ANNOTATION_TOKENS = 12

/**
 * Scripts written without spaces between words. Their tokens never start with a space, so joining
 * every token that doesn't would make a whole chunk one "word" and give it one speaker; each token
 * is its own word instead, and keeps no leading space so the text still reads unspaced.
 */
const SPACELESS =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u

type Token = { text: string; start: number; end: number }

function tokensOf(result: { transcription?: unknown }): Token[] {
  const rows: unknown[] = Array.isArray(result.transcription) ? result.transcription : []
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 3) return []
    return [{ text: String(row[2] ?? ''), start: seconds(row[0]), end: seconds(row[1]) }]
  })
}

function addToken(words: TranscriptWord[], token: Token): void {
  const { text, start, end } = token
  if (!text.trim()) return
  const spaced = /^\s/.test(text)
  const spaceless = SPACELESS.test(text)
  const last = words.at(-1)
  if (last && !spaced && !spaceless) {
    last.text += text
    last.end = end
  } else {
    words.push({ text: spaceless && !spaced ? text.trim() : ` ${text.trim()}`, start, end })
  }
}

/**
 * With `max_len: 1` Whisper returns one row per token: [start, end, text].
 * Tokens that start with a space begin a new word; the rest (punctuation,
 * word pieces) attach to the previous word. Annotations such as [BLANK_AUDIO],
 * (music) or *Gunshot* (large-v3-turbo's name for a keyboard click) are dropped.
 */
export function wordsFromTokens(result: { transcription?: unknown }): TranscriptWord[] {
  const words: TranscriptWord[] = []
  let bracketDepth = 0
  let starred = false
  let span: Token[] = []

  for (const token of tokensOf(result)) {
    const { text } = token
    const opens = (text.match(/[[(]/g) ?? []).length
    const closes = (text.match(/[\])]/g) ?? []).length
    const stars = (text.match(/\*/g) ?? []).length
    const inside = bracketDepth > 0 || opens > 0 || starred || stars > 0
    bracketDepth = Math.max(0, bracketDepth + opens - closes)
    if (stars % 2 === 1) starred = !starred
    if (!inside) {
      addToken(words, token)
      continue
    }
    span.push(token)
    if (bracketDepth === 0 && !starred) {
      span = []
    } else if (span.length > MAX_ANNOTATION_TOKENS) {
      for (const held of span) addToken(words, held)
      span = []
      bracketDepth = 0
      starred = false
    }
  }
  // A short span still open at the end is an annotation cut off with the chunk ("(music"): dropped.
  // Whisper marks speech that runs past the end of the buffer with "..."; that is not dictation.
  return words
    .map((word) => ({ ...word, text: word.text.replace(/(?:\.\.\.|…)+/g, '') }))
    .filter((word) => word.text.trim())
}

/** Letters and digits in any script, lowercased, single-spaced: "I'm" and "i m" compare equal. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const HallucinationList = z.object({ phrases: z.array(z.string()) })

/**
 * What Whisper writes when it hears no speech ("Thanks for watching", "Subtitles by the Amara.org
 * community", and the same in other languages), from published lists pulled in by
 * `scripts/update-word-lists.cjs`. Only a whole chunk that is one of these is dropped.
 */
const HALLUCINATIONS = new Set(HallucinationList.parse(hallucinationList).phrases.map(normalize).filter(Boolean))

/** A sentence this many times, making up this share of a chunk, is Whisper looping. */
const LOOP_REPEATS = 3
const LOOP_SHARE = 0.6
/**
 * A one-word sentence has to repeat far more to be a loop: "No. No. No." and "Okay. Okay. Okay."
 * are how people answer. Whisper's loops on noise run on to fill the window, dozens of times.
 */
const LOOP_REPEATS_ONE_WORD = 8

/**
 * Whisper looping on a sound it can't make out: mostly one sentence over and over ("I'm very
 * impressed. I'm very impressed. I'm very impressed."). Real speech repeats a word, rarely a
 * whole chunk of the same sentence.
 */
export function isLoop(raw: string): boolean {
  const sentences = raw
    .split(/(?<=[.!?。！？।؟])\s*/u)
    .map(normalize)
    .filter(Boolean)
  if (sentences.length < LOOP_REPEATS) return false
  const counts = new Map<string, number>()
  for (const sentence of sentences) counts.set(sentence, (counts.get(sentence) ?? 0) + 1)
  let top = ''
  let most = 0
  for (const [sentence, count] of counts) {
    if (count > most) {
      top = sentence
      most = count
    }
  }
  const needed = top.includes(' ') ? LOOP_REPEATS : LOOP_REPEATS_ONE_WORD
  return most >= needed && most / sentences.length >= LOOP_SHARE
}

/** Echoes shorter than this are too common in real talk ("thank you", "yeah") to judge at all. */
const ECHO_MIN_CHARS = 12
/**
 * Whisper copies its prompt word for word, ending where the prompt ends. A repeat of that length
 * is rarely real: people don't say the same eight words twice running on one track.
 */
const LONG_ECHO_WORDS = 8
/**
 * The audio a chunk's words need to be speech. Under 0.15 s a word (over six words a second,
 * faster than anyone talks) the text can't be what was said. Over 3 s a word the chunk is mostly
 * not speech (a keyboard, a fan, the far end's echo) and Whisper filled it from the prompt. A
 * genuine "Sounds good to me." takes 1 to 3 s with the chunker's padding: 0.25 to 0.75 s a word.
 */
const MIN_SECONDS_PER_WORD = 0.15
const MAX_SECONDS_PER_WORD = 3

/**
 * Whisper repeating the end of its prompt instead of transcribing. Only a near-exact copy of the
 * prompt's tail counts, not any phrase that appears somewhere in the last 300 characters or the
 * title, and a short one only when the audio can't hold it as speech: someone who says "sounds
 * good to me" twice in a row said it twice.
 */
export function isPromptEcho(text: string, prompt: string, audioSeconds: number): boolean {
  if (text.length <= ECHO_MIN_CHARS) return false
  const context = normalize(prompt)
  const at = context.lastIndexOf(text)
  if (at < 0 || at + text.length !== context.length) return false
  if (at > 0 && context[at - 1] !== ' ') return false
  const count = text.split(' ').length
  if (count >= LONG_ECHO_WORDS) return true
  const perWord = audioSeconds / count
  return perWord < MIN_SECONDS_PER_WORD || perWord > MAX_SECONDS_PER_WORD
}

/**
 * Drops the stock phrases Whisper invents on silence, loops, and echoes of its own prompt.
 * `audioSeconds` is the length of the chunk Whisper heard.
 */
export function isHallucination(words: TranscriptWord[], prompt: string, audioSeconds: number): boolean {
  const raw = words.map((word) => word.text).join('')
  const text = normalize(raw)
  if (!text || HALLUCINATIONS.has(text) || isLoop(raw)) return true
  return isPromptEcho(text, prompt, audioSeconds)
}

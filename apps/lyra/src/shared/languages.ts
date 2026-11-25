import { z } from 'zod'
import generated from './data/whisperLanguages.json'

/**
 * The languages Whisper transcribes, taken from its tokenizer by `scripts/update-word-lists.cjs`
 * rather than written out here.
 */
const LanguageList = z.object({
  languages: z.array(z.object({ code: z.string().min(2), name: z.string().min(1) })).min(1)
})

export const WHISPER_LANGUAGES = LanguageList.parse(generated).languages

const CODES = new Set(WHISPER_LANGUAGES.map((language) => language.code))

/** A Whisper language code, or `auto` to let Whisper detect it for each chunk. */
export const TranscriptionLanguage = z.union([
  z.literal('auto'),
  z.string().refine((code) => CODES.has(code), 'not a language Whisper knows')
])
export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguage>

/** The first of the user's preferred languages Whisper knows (`en-GB` → `en`), else English. */
export function defaultLanguage(preferred: readonly string[]): TranscriptionLanguage {
  for (const tag of preferred) {
    const code = tag.toLowerCase().split(/[-_]/)[0] ?? ''
    if (CODES.has(code)) return code
  }
  return 'en'
}

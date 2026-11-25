import { z } from 'zod'

/**
 * Custom vocabulary: names and jargon the user expects in sessions, given to Whisper ahead of
 * each chunk so it spells them the way the user does. One module for the setting's schema, the
 * Settings editor and the prompt, so all three agree on the limits.
 */

/** Longest term kept: a name or a phrase, never a paragraph. */
export const MAX_TERM_CHARS = 60
/** Most terms kept. */
export const MAX_TERMS = 100
/**
 * Characters of vocabulary in Whisper's prompt. The prompt holds about 224 tokens and the
 * track's earlier text takes up to 300 characters of it; whisper.cpp keeps the prompt's tail, so
 * a longer list would push out the start of the list, not the context.
 */
export const MAX_PROMPT_CHARS = 400

/** Trimmed, blank and duplicate (ignoring case) terms dropped, first spelling kept. */
export function dedupeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ')
    const key = term.toLowerCase()
    if (!term || seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/** The `vocabulary` setting. A bad stored value falls back as a whole (see `parseSettings`). */
export const Vocabulary = z
  .array(z.string().trim().min(1).max(MAX_TERM_CHARS))
  .max(MAX_TERMS)
  .transform(dedupeTerms)

export type AddTermsResult =
  | { status: 'added'; terms: string[]; added: number }
  | { status: 'unchanged'; reason: 'empty' | 'duplicate' | 'too-long' | 'full' }

/**
 * `input` added to `terms`: split on commas, semicolons and new lines (a pasted list), each
 * trimmed; too-long terms are refused rather than cut, and the list stops at `MAX_TERMS`.
 */
export function addTerms(terms: readonly string[], input: string): AddTermsResult {
  const incoming = dedupeTerms(input.split(/[,;\n]/))
  if (!incoming.length) return { status: 'unchanged', reason: 'empty' }
  if (incoming.some((term) => term.length > MAX_TERM_CHARS)) return { status: 'unchanged', reason: 'too-long' }
  const merged = dedupeTerms([...terms, ...incoming]).slice(0, MAX_TERMS)
  const added = merged.length - terms.length
  if (added > 0) return { status: 'added', terms: merged, added }
  return { status: 'unchanged', reason: terms.length >= MAX_TERMS ? 'full' : 'duplicate' }
}

/**
 * Whisper's prompt with the vocabulary in front of the track's earlier text: `"Acme, Dillon,
 * Kubernetes. <context>"`. Terms past `MAX_PROMPT_CHARS` are left out whole. With no terms the
 * prompt is returned unchanged, so an empty list behaves exactly as before.
 */
export function withVocabulary(prompt: string, terms: readonly string[]): string {
  const kept: string[] = []
  let length = 0
  for (const term of terms) {
    const next = length + (kept.length ? 2 : 0) + term.length
    if (next > MAX_PROMPT_CHARS) break
    kept.push(term)
    length = next
  }
  if (!kept.length) return prompt
  const glossary = `${kept.join(', ')}.`
  return prompt ? `${glossary} ${prompt}` : glossary
}

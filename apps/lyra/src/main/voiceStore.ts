import { z } from 'zod'
import type { Person } from '../shared/types'
import { guessModel } from './meeting/speakerModel'

/**
 * The shape of voices.json and the rules for what a voiceprint keeps. Pure (no Electron, no
 * files), so the rules are unit-tested; `voices.ts` does the reading, writing and locking.
 */

export const VOICES_VERSION = 2

/** Older samples are dropped past this, so a voiceprint follows how someone sounds now. */
export const MAX_SAMPLES = 20

/**
 * Where a sample came from. `enrolled`: the user recorded it to save the voice. `user`: the user
 * named a session's speaker as this person. `auto`: Lyra matched the voice on its own. Only auto
 * samples can be wrong without the user having said so, so they are the ones evicted first.
 */
export const SampleSource = z.enum(['enrolled', 'user', 'auto'])
export type SampleSource = z.infer<typeof SampleSource>

const finite = z.number().refine(Number.isFinite)

export const VoiceSample = z.looseObject({
  vector: z.array(finite),
  /** The embedding model that made `vector`; only same-model samples are compared. */
  model: z.string(),
  dims: z.number().int(),
  source: SampleSource,
  /** The session the sample was taken from; null for an enrollment recording. */
  sessionId: z.string().nullable(),
  createdAt: z.string()
})
export type VoiceSample = z.infer<typeof VoiceSample>

// Loose, so fields a newer build added to a person survive this build saving them.
export const StoredPerson = z.looseObject({
  id: z.string(),
  name: z.string(),
  self: z.boolean(),
  createdAt: z.string(),
  samples: z.array(VoiceSample)
})
export type StoredPerson = z.infer<typeof StoredPerson>

/** A person as version 1 saved them: bare vectors, with no record of where each came from. */
const LegacyPerson = z.looseObject({
  id: z.string(),
  name: z.string(),
  self: z.boolean(),
  createdAt: z.string(),
  embeddings: z.array(z.array(finite))
})

const VoicesFile = z.object({ version: z.number().int(), people: z.array(z.unknown()) })

/** What voices.json holds: people this build understands, and entries it doesn't, kept as is. */
export type VoicesState = { people: StoredPerson[]; unreadable: unknown[] }

/**
 * Upgrades a version 1 person. Their samples' history wasn't recorded, so this guesses: the
 * first sample is taken as enrolled (a person was always created from one the user chose, by
 * recording it or by naming a speaker) and the rest as automatic, which is what most later
 * samples were. Guessing "auto" for a sample the user actually gave only makes it evictable
 * before the rest; guessing "enrolled" for an automatic one would pin a possibly wrong sample.
 */
function upgradeLegacy(legacy: z.infer<typeof LegacyPerson>): StoredPerson {
  const { embeddings, ...rest } = legacy
  return {
    ...rest,
    samples: embeddings.map((vector, index) => ({
      vector,
      model: guessModel(vector),
      dims: vector.length,
      source: index === 0 ? 'enrolled' : 'auto',
      sessionId: null,
      createdAt: legacy.createdAt
    }))
  }
}

function readEntry(entry: unknown): StoredPerson | null {
  const person = StoredPerson.safeParse(entry)
  if (person.success) return person.data
  const legacy = LegacyPerson.safeParse(entry)
  return legacy.success ? upgradeLegacy(legacy.data) : null
}

/**
 * Reads voices.json's parsed contents. Null when it isn't a voices file at all (the caller keeps
 * a copy before starting over). An entry that doesn't validate is kept verbatim, so a newer
 * build's people or a damaged one aren't dropped by the next save.
 */
export function parseVoices(parsed: unknown): VoicesState | null {
  // Version 1 was a bare array of people.
  const file = Array.isArray(parsed) ? { people: parsed } : VoicesFile.safeParse(parsed).data
  if (!file) return null
  const state: VoicesState = { people: [], unreadable: [] }
  for (const entry of file.people) {
    const person = readEntry(entry)
    if (person) state.people.push(person)
    else state.unreadable.push(entry)
  }
  return state
}

export function serializeVoices(state: VoicesState): string {
  return JSON.stringify({ version: VOICES_VERSION, people: [...state.people, ...state.unreadable] })
}

export function toPerson(stored: StoredPerson): Person {
  return {
    id: stored.id,
    name: stored.name,
    self: stored.self,
    createdAt: stored.createdAt,
    samples: stored.samples.length
  }
}

/**
 * Adds a sample to a voiceprint, keeping it to `max` samples:
 * - A session teaches a voice at most one automatic sample: a later pass over the same session
 *   (relabeling runs after every take) replaces it, and none is added when the user already
 *   gave a sample from that session.
 * - Past `max`, the oldest automatic sample goes first. Automatic samples never push out an
 *   enrolled or user-given one: with no automatic sample left to drop, a new one isn't kept.
 *   A user's sample can push out older user samples, then enrolled ones, never itself.
 */
export function addSampleTo(person: StoredPerson, sample: VoiceSample, max = MAX_SAMPLES): StoredPerson {
  let samples = person.samples
  if (sample.source === 'auto' && sample.sessionId !== null) {
    const { sessionId } = sample
    if (samples.some((entry) => entry.sessionId === sessionId && entry.source !== 'auto')) return person
    samples = samples.filter((entry) => !(entry.sessionId === sessionId && entry.source === 'auto'))
  }
  samples = [...samples, sample]
  const order: SampleSource[] = sample.source === 'auto' ? ['auto'] : ['auto', 'user', 'enrolled']
  for (const source of order) {
    while (samples.length > max) {
      // The new sample is last; never evict it.
      const index = samples.findIndex((entry, i) => entry.source === source && i < samples.length - 1)
      if (index < 0) break
      samples = samples.filter((_, i) => i !== index)
    }
  }
  if (samples.length > max) return person
  return { ...person, samples }
}

/** What a voiceprint is being compared with: its model, and the session it came from. */
/**
 * `people` without what `sessionId` taught anyone but `keepId` about one voice: the samples taken
 * from that session (never an enrolled one) that are `vector`'s voice, at `minSimilarity` or
 * closer. For when a session's speaker is named again as someone else. `emptied` lists the people
 * left with no samples at all.
 */
export function withoutSessionVoice(
  people: readonly StoredPerson[],
  sessionId: string,
  vector: readonly number[],
  keepId: string | null,
  minSimilarity: number
): { people: StoredPerson[]; removed: number; emptied: string[] } {
  let removed = 0
  const emptied: string[] = []
  const next = people.map((person) => {
    if (person.id === keepId) return person
    const samples = person.samples.filter(
      (sample) =>
        sample.source === 'enrolled' ||
        sample.sessionId !== sessionId ||
        sample.vector.length !== vector.length ||
        cosine(sample.vector, vector) < minSimilarity
    )
    if (samples.length === person.samples.length) return person
    removed += person.samples.length - samples.length
    if (samples.length === 0) emptied.push(person.id)
    return { ...person, samples }
  })
  return { people: next, removed, emptied }
}

export type ScoreContext = { model: string; dims: number; sessionId: string | null }

/**
 * The samples a voiceprint can be compared with: same model and size, and not from the session
 * being labeled (a session vouching for its own speakers would just confirm its own guesses).
 */
export function usableSamples(person: StoredPerson, context: ScoreContext): number[][] {
  return person.samples
    .filter(
      (sample) =>
        sample.model === context.model &&
        sample.dims === context.dims &&
        sample.vector.length === context.dims &&
        (context.sessionId === null || sample.sessionId !== context.sessionId)
    )
    .map((sample) => sample.vector)
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function mean(vectors: readonly number[][]): number[] {
  const first = vectors[0]
  if (!first) return []
  const out = new Array<number>(first.length).fill(0)
  for (const vector of vectors) vector.forEach((value, i) => (out[i] = (out[i] ?? 0) + value))
  return out.map((value) => value / vectors.length)
}

/**
 * How close `embedding` is to a person's voice, or null with nothing to compare. The better of
 * their averaged voiceprint and their closest single sample, so one good sample from a similar
 * setup (same mic, same call app) still counts.
 */
export function personScore(
  person: StoredPerson,
  embedding: readonly number[],
  context: ScoreContext
): number | null {
  const usable = usableSamples(person, context)
  if (usable.length === 0) return null
  return Math.max(cosine(embedding, mean(usable)), ...usable.map((sample) => cosine(embedding, sample)))
}

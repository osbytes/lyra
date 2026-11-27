import { LOW_CONFIDENCE, type SpeakerEntry, type SpeakerMatch } from '../../../shared/sessionDoc'
import type { Person } from '../../../shared/types'

/**
 * What the speaker picker offers, in three groups: saved voices that sound like this speaker,
 * the others already in this session, then every other saved voice. A voice that only "unlikely"
 * matches isn't a suggestion: listing it first, highlighted, made Enter name a speaker after
 * whoever happened to be saved first.
 */

export type OptionGroup = 'match' | 'here' | 'saved'

export type SpeakerOption =
  | { kind: 'person'; person: Person; score: number | null; group: OptionGroup }
  | { kind: 'speaker'; speaker: SpeakerEntry; group: 'here' }
  | { kind: 'new'; name: string }
  | { kind: 'keep' }

export const GROUP_LABEL: Readonly<Record<OptionGroup, string>> = {
  match: 'Sounds like',
  here: 'In this session',
  saved: 'Saved voices'
}

export function speakerOptions(input: {
  query: string
  speaker: Pick<SpeakerEntry, 'id' | 'matches'>
  /** The session's speakers, this one included. */
  speakers: readonly SpeakerEntry[]
  people: readonly Person[]
}): SpeakerOption[] {
  const needle = input.query.trim().toLowerCase()
  const fits = (name: string): boolean => name.toLowerCase().includes(needle)
  const scoreOf = (id: string): number | null =>
    input.speaker.matches.find((match: SpeakerMatch) => match.personId === id)?.score ?? null
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

  const others = input.speakers.filter((entry) => entry.id !== input.speaker.id)
  const hereIds = new Set(others.flatMap((entry) => (entry.personId ? [entry.personId] : [])))
  const people = input.people.filter((person) => fits(person.name))

  const match = people
    .map((person) => ({ person, score: scoreOf(person.id) }))
    .filter((entry): entry is { person: Person; score: number } => entry.score !== null && entry.score >= LOW_CONFIDENCE)
    .sort((a, b) => b.score - a.score || byName(a.person, b.person))
  const suggested = new Set(match.map((entry) => entry.person.id))

  // Speakers here who are a saved voice show as that person; the rest as themselves.
  const herePeople = people
    .filter((person) => hereIds.has(person.id) && !suggested.has(person.id))
    .sort(byName)
  const hereSpeakers = others
    .filter((entry) => !entry.personId && fits(entry.name))
    .sort((a, b) => byName(a, b))
  const saved = people
    .filter((person) => !suggested.has(person.id) && !hereIds.has(person.id))
    .sort(byName)

  const out: SpeakerOption[] = [
    ...match.map(({ person, score }) => ({ kind: 'person' as const, person, score, group: 'match' as const })),
    ...herePeople.map((person) => ({ kind: 'person' as const, person, score: scoreOf(person.id), group: 'here' as const })),
    ...hereSpeakers.map((entry) => ({ kind: 'speaker' as const, speaker: entry, group: 'here' as const })),
    ...saved.map((person) => ({ kind: 'person' as const, person, score: scoreOf(person.id), group: 'saved' as const }))
  ]
  const exact =
    input.people.some((person) => person.name.trim().toLowerCase() === needle) ||
    others.some((entry) => entry.name.trim().toLowerCase() === needle)
  if (needle && !exact) out.push({ kind: 'new', name: input.query.trim() })
  out.push({ kind: 'keep' })
  return out
}

/**
 * Which option Enter picks before the user moves: a voice that sounds like this speaker, or
 * what they typed; with neither, nothing (-1), rather than a guess.
 */
export function defaultHighlight(options: readonly SpeakerOption[], query: string): number {
  const needle = query.trim().toLowerCase()
  const first = options[0]
  if (!first) return -1
  if (!needle) return first.kind === 'person' && first.group === 'match' ? 0 : -1
  const nameOf = (option: SpeakerOption): string | null =>
    option.kind === 'person' ? option.person.name : option.kind === 'speaker' ? option.speaker.name : null
  const exact = options.findIndex((option) => nameOf(option)?.trim().toLowerCase() === needle)
  // Otherwise the closest name that fits, or the new person typed when none does.
  return exact >= 0 ? exact : 0
}

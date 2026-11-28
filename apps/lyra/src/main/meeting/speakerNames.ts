import {
  renumberSpeakers,
  SURE_MATCH,
  type SessionDoc,
  type SpeakerEntry,
  type SpeakerIntroduction
} from '../../shared/sessionDoc'
import type { Person } from '../../shared/types'
import type { SpeakersFound } from './notesFormat'

/**
 * Speaker names from what was said, worked out by the notes model (`NotesWriter.speakers`): it
 * reads the transcript with each unnamed voice under a neutral label and says who is who, only
 * where the talk makes it clear. Its answer is a guess the user confirms ("Is this Maya?"): the
 * line may be on the wrong voice, or the name misheard. A speaker the user named, or a saved
 * voice that is sure, is never renamed. This module is the pure part: what the model is shown,
 * and checking and applying what it says.
 */

/** What the model reads, and how to read its answer back. */
export type SpeakerTranscript = {
  /** `[n] Label: text` lines, numbered from 1. */
  text: string
  /** Each unnamed speaker's label ("Speaker A") to its id. */
  labels: Map<string, string>
  /** Line number n's id is `lines[n - 1]`, and its text `texts[n - 1]`. */
  lines: string[]
  texts: string[]
}

const settled = (speaker: SpeakerEntry): boolean =>
  speaker.confirmed || (speaker.confidence ?? 0) >= SURE_MATCH

function label(index: number): string {
  return index < 26 ? `Speaker ${String.fromCharCode(65 + index)}` : `Speaker ${String(index + 1)}`
}

/**
 * The transcript as the model sees it. Speakers still to be named get a neutral label, in order
 * of first appearance, even when a weak voice match guessed someone: the guess would lead the
 * model. Settled speakers keep their names, which help it tell who is talking to whom. Returns
 * null when there is no one to name.
 */
export function speakerTranscript(doc: SessionDoc): SpeakerTranscript | null {
  const byId = new Map(doc.speakers.map((speaker) => [speaker.id, speaker]))
  const labels = new Map<string, string>()
  const labelOf = new Map<string, string>()
  const rows: string[] = []
  const lines: string[] = []
  const texts: string[] = []
  for (const line of doc.transcript) {
    const text = line.text.trim()
    if (!text) continue
    const speaker = line.cluster ? byId.get(line.cluster) : undefined
    let name = speaker?.name ?? 'Unknown speaker'
    if (speaker && !settled(speaker)) {
      name = labelOf.get(speaker.id) ?? label(labelOf.size)
      labelOf.set(speaker.id, name)
      labels.set(name, speaker.id)
    }
    lines.push(line.id)
    texts.push(text)
    rows.push(`[${String(lines.length)}] ${name}: ${text}`)
  }
  return labels.size ? { text: rows.join('\n'), labels, lines, texts } : null
}

/** Words without case, accents or the punctuation around them. */
function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((word) => word.replace(/^['’-]+|['’-]+$/g, ''))
    .filter(Boolean)
}

/**
 * Whether the line the model cites says the name it gave: its evidence, checked. Asked for an
 * entry per speaker, a small model fills one it can't name with a plausible name (the prompt's
 * own example, in testing); a name that isn't in the line it points to is one it made up.
 */
function says(text: string, name: string): boolean {
  const [first] = words(name)
  return first !== undefined && words(text).includes(first)
}

/** One name is the other or its start: "Maya" and "Maya Chen" are the same person. */
export function sameName(a: string, b: string): boolean {
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length)
  if (!short?.length || !long) return false
  return short.every((word, index) => word === long[index])
}

/** Longer than any name; a model that answers with a sentence has misread the task. */
const MAX_NAME = 60

/**
 * The model's answer checked against what it was shown: labels it was given, lines that exist and
 * say the name, something that looks like a name. A speaker it named twice differently, or a name
 * it gave two speakers, is left out.
 */
export function namesFrom(found: SpeakersFound, view: SpeakerTranscript): Map<string, SpeakerIntroduction> {
  const said = new Map<string, SpeakerIntroduction[]>()
  for (const entry of found.speakers) {
    const id = view.labels.get(entry.label.trim())
    const lineId = view.lines[entry.line - 1]
    const text = view.texts[entry.line - 1] ?? ''
    const name = entry.name.replace(/\s+/g, ' ').trim()
    if (!id || !lineId || !name || name.length > MAX_NAME || !/\p{L}/u.test(name) || !says(text, name)) continue
    said.set(id, [...(said.get(id) ?? []), { name, lineId }])
  }
  const out = new Map<string, SpeakerIntroduction>()
  for (const [id, heard] of said) {
    const [first] = heard
    if (!first || !heard.every((entry) => sameName(entry.name, first.name))) continue
    const elsewhere = [...said].some(
      ([other, names]) => other !== id && names.some((entry) => sameName(entry.name, first.name))
    )
    if (elsewhere) continue
    out.set(id, heard.reduce((best, entry) => (words(entry.name).length > words(best.name).length ? entry : best)))
  }
  return out
}

/** The saved person with this name: the same name, else the only one it can be short for. */
export function personNamed<T extends Pick<Person, 'id' | 'name'>>(people: readonly T[], name: string): T | null {
  const key = words(name).join(' ')
  const exact = people.find((person) => words(person.name).join(' ') === key)
  if (exact) return exact
  const close = people.filter((person) => sameName(person.name, name))
  return close.length === 1 ? (close[0] ?? null) : null
}

/**
 * Gives each speaker the name found for them, as a guess: a saved person of that name, else the
 * name as said. Checked again here, against the session as it is now: a speaker the user named
 * meanwhile, or a saved voice that is sure, keeps its name, as does one whose name another
 * speaker here surely has; a line that is gone takes its finding with it. Returns how many
 * speakers it named.
 */
export function introduceSpeakers(
  doc: SessionDoc,
  found: ReadonlyMap<string, SpeakerIntroduction>,
  people: readonly Pick<Person, 'id' | 'name'>[]
): number {
  const lineIds = new Set(doc.transcript.map((line) => line.id))
  let named = 0
  for (const speaker of doc.speakers) {
    const heard = found.get(speaker.id)
    if (!heard || settled(speaker) || !lineIds.has(heard.lineId)) continue
    const others = doc.speakers.filter((other) => other.id !== speaker.id)
    if (others.some((other) => settled(other) && sameName(other.name, heard.name))) continue
    const person = personNamed(people, heard.name)
    // Each saved person labels one speaker, as with voices.
    if (person && others.some((other) => other.personId === person.id)) continue
    const personId = person?.id ?? null
    // A weak voice match for someone else says nothing about this person.
    if (personId !== speaker.personId) speaker.confidence = null
    speaker.name = person?.name ?? heard.name
    speaker.personId = personId
    speaker.introduced = heard
    named++
  }
  if (named) renumberSpeakers(doc)
  return named
}

import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Person } from '../shared/types'
import { log } from './log'

/**
 * Saved voiceprints ("people"). Stored only in userData, never in the notes
 * folder, so they aren't synced or shared along with notes.
 */

type StoredPerson = Person & { embeddings: number[][] }

/** Older samples are dropped past this, so a voiceprint follows how someone sounds now. */
const MAX_SAMPLES = 20

let people: StoredPerson[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'voices.json')
}

function isStoredPerson(value: unknown): value is StoredPerson {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.id === 'string' &&
    typeof raw.name === 'string' &&
    typeof raw.self === 'boolean' &&
    typeof raw.createdAt === 'string' &&
    Array.isArray(raw.embeddings) &&
    raw.embeddings.every(
      (entry) => Array.isArray(entry) && entry.every((n) => typeof n === 'number')
    )
  )
}

async function load(): Promise<StoredPerson[]> {
  if (people) return people
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf8'))
    people = Array.isArray(parsed) ? parsed.filter(isStoredPerson) : []
  } catch {
    people = []
  }
  return people
}

async function save(next: StoredPerson[]): Promise<void> {
  people = next
  const path = storePath()
  await writeFile(`${path}.tmp`, JSON.stringify(next), 'utf8')
  await rename(`${path}.tmp`, path)
  const summary = next.map(toPerson)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('people:changed', summary)
  for (const listener of saveListeners) listener(next.map(toVoicePerson))
}

/** A person with their voiceprint samples, for stores that mirror voices.json (the search index). */
export type VoicePerson = Person & { voiceprints: number[][] }

const toVoicePerson = (stored: StoredPerson): VoicePerson => ({
  ...toPerson(stored),
  voiceprints: stored.embeddings
})

const saveListeners = new Set<(people: VoicePerson[]) => void>()

export function onPeopleSaved(listener: (people: VoicePerson[]) => void): () => void {
  saveListeners.add(listener)
  return () => saveListeners.delete(listener)
}

export async function listVoicePeople(): Promise<VoicePerson[]> {
  return (await load()).map(toVoicePerson)
}

function toPerson(stored: StoredPerson): Person {
  return {
    id: stored.id,
    name: stored.name,
    self: stored.self,
    createdAt: stored.createdAt,
    samples: stored.embeddings.length
  }
}

export async function listPeople(): Promise<Person[]> {
  return (await load()).map(toPerson)
}

export async function getPerson(id: string): Promise<Person | null> {
  const found = (await load()).find((person) => person.id === id)
  return found ? toPerson(found) : null
}

export async function addPerson(name: string, embedding: number[], self: boolean): Promise<Person> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A name is required')
  const list = await load()
  const person: StoredPerson = {
    id: randomUUID(),
    name: trimmed,
    self,
    createdAt: new Date().toISOString(),
    samples: 1,
    embeddings: [embedding]
  }
  // Only one person can be "me".
  const others = self ? list.map((entry) => ({ ...entry, self: false })) : list
  await save([...others, person])
  log('voices', 'added person', { id: person.id, self })
  return toPerson(person)
}

export async function addSample(id: string, embedding: number[]): Promise<void> {
  const list = await load()
  await save(
    list.map((person) =>
      person.id === id
        ? { ...person, embeddings: [...person.embeddings, embedding].slice(-MAX_SAMPLES) }
        : person
    )
  )
}

export async function renamePerson(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A name is required')
  const list = await load()
  await save(list.map((person) => (person.id === id ? { ...person, name: trimmed } : person)))
}

/** Marks one person as "me", or nobody when `id` is null. */
export async function setSelf(id: string | null): Promise<void> {
  const list = await load()
  await save(list.map((person) => ({ ...person, self: person.id === id })))
}

/** People deleted this run, kept in memory only so the window can undo the delete. */
const deleted = new Map<string, { person: StoredPerson; index: number }>()

/** Deletes the person and every voiceprint sample of theirs. */
export async function deletePerson(id: string): Promise<void> {
  const list = await load()
  const index = list.findIndex((person) => person.id === id)
  const person = list[index]
  if (person) deleted.set(id, { person, index })
  await save(list.filter((entry) => entry.id !== id))
  log('voices', 'deleted person', { id })
}

/** Undoes `deletePerson`, back in the same place in the list. */
export async function restorePerson(id: string): Promise<void> {
  const entry = deleted.get(id)
  if (!entry) throw new Error('This person can no longer be restored')
  deleted.delete(id)
  const list = await load()
  if (list.some((person) => person.id === id)) return
  // Someone else may have become "me" since; they keep it.
  const takenSelf = list.some((person) => person.self)
  const person = { ...entry.person, self: entry.person.self && !takenSelf }
  await save([...list.slice(0, entry.index), person, ...list.slice(entry.index)])
  log('voices', 'restored person', { id })
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

function mean(vectors: number[][]): number[] {
  const first = vectors[0]
  if (!first) return []
  const out = new Array<number>(first.length).fill(0)
  for (const vector of vectors) vector.forEach((value, i) => (out[i] = (out[i] ?? 0) + value))
  return out.map((value) => value / vectors.length)
}

export type VoiceMatch = { person: Person; score: number }

/**
 * How close `embedding` is to each saved voice, best first. A person's score is the
 * better of their averaged voiceprint and their closest single sample, so one good
 * sample from a similar setup (same mic, same call app) still counts.
 */
export async function scoreVoices(embedding: readonly number[]): Promise<VoiceMatch[]> {
  return (await load())
    .flatMap((person) => {
      // Samples from an older speaker model have another length and can't be compared; the
      // person is recognized again once they're named in a session (which adds a sample).
      const usable = person.embeddings.filter((sample) => sample.length === embedding.length)
      if (usable.length === 0) return []
      const samples = usable.map((sample) => cosine(embedding, sample))
      const score = Math.max(cosine(embedding, mean(usable)), ...samples)
      return [{ person: toPerson(person), score }]
    })
    .sort((a, b) => b.score - a.score)
}

export async function selfPerson(): Promise<Person | null> {
  const found = (await load()).find((person) => person.self)
  return found ? toPerson(found) : null
}

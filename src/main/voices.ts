import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Person } from '../shared/types'
import { log } from './log'

/**
 * Saved voiceprints ("people"). Stored only in userData — never in the notes
 * folder — so they aren't synced or shared along with notes.
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

export async function setSelf(id: string): Promise<void> {
  const list = await load()
  await save(list.map((person) => ({ ...person, self: person.id === id })))
}

/** Deletes the person and every voiceprint sample of theirs. */
export async function deletePerson(id: string): Promise<void> {
  const list = await load()
  await save(list.filter((person) => person.id !== id))
  log('voices', 'deleted person', { id })
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

/** The saved person whose voice is closest to `embedding`, if any clears `threshold`. */
export async function matchVoice(
  embedding: readonly number[],
  threshold: number
): Promise<VoiceMatch | null> {
  let best: VoiceMatch | null = null
  for (const person of await load()) {
    const score = cosine(embedding, mean(person.embeddings))
    if (score >= threshold && (!best || score > best.score)) best = { person: toPerson(person), score }
  }
  return best
}

export async function selfPerson(): Promise<Person | null> {
  const found = (await load()).find((person) => person.self)
  return found ? toPerson(found) : null
}

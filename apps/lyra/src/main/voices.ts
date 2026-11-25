import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Person } from '../shared/types'
import { log } from './log'
import { SPEAKER_EMBEDDING } from './meeting/speakerModel'
import {
  addSampleTo,
  parseVoices,
  personScore,
  serializeVoices,
  toPerson,
  type SampleSource,
  type StoredPerson,
  type VoiceSample,
  type VoicesState
} from './voiceStore'

export { cosine } from './voiceStore'

/**
 * Saved voiceprints ("people"). Stored only in userData, never in the notes
 * folder, so they aren't synced or shared along with notes.
 */

let state: Promise<VoicesState> | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'voices.json')
}

const errorCode = (error: unknown): unknown =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined

/**
 * Reads voices.json. A file that can't be parsed is copied aside before starting empty, so the
 * next save doesn't overwrite the only copy of every saved voice. A file that can't be read at
 * all (permissions, a locked file) fails the load instead: starting empty would overwrite it.
 */
async function readStore(): Promise<VoicesState> {
  const path = storePath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { people: [], unreadable: [] }
    throw error
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Handled below with any other file that isn't a voices file.
  }
  const read = parseVoices(parsed)
  if (read) {
    if (read.unreadable.length) log('voices', 'kept entries it could not read', { count: read.unreadable.length })
    return read
  }
  const aside = join(app.getPath('userData'), `voices.corrupt-${String(Date.now())}.json`)
  await copyFile(path, aside)
  log('voices', 'voices.json was unreadable; kept a copy and started empty', { copy: aside })
  return { people: [], unreadable: [] }
}

function load(): Promise<VoicesState> {
  if (!state) {
    const loading = readStore()
    state = loading
    // A failed load is retried next time rather than remembered.
    loading.catch(() => {
      if (state === loading) state = null
    })
  }
  return state
}

async function write(next: VoicesState): Promise<void> {
  const path = storePath()
  // Unique, so two writers (or a crashed earlier one) never share a half-written file.
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, serializeVoices(next), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Mutations run one at a time, each on the state the previous one left. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Loads, changes and saves the store as one step, so a voice learned by a relabel while the user
 * names a speaker can't overwrite the other's change. `change` returns null to save nothing.
 */
function mutate<T>(change: (people: StoredPerson[]) => { people: StoredPerson[]; result: T } | null): Promise<T | null> {
  const run = queue.then(async () => {
    const current = await load()
    const changed = change(current.people)
    if (!changed) return null
    const next = { ...current, people: changed.people }
    await write(next)
    state = Promise.resolve(next)
    notify(next.people)
    return changed.result
  })
  queue = run.catch(() => undefined)
  return run
}

function notify(people: StoredPerson[]): void {
  const summary = people.map(toPerson)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('people:changed', summary)
  for (const listener of saveListeners) listener(people.map(toVoicePerson))
}

/** A person with their voiceprint samples, for stores that mirror voices.json (the search index). */
export type VoicePerson = Person & { voiceprints: number[][] }

const toVoicePerson = (stored: StoredPerson): VoicePerson => ({
  ...toPerson(stored),
  voiceprints: stored.samples.map((sample) => sample.vector)
})

const saveListeners = new Set<(people: VoicePerson[]) => void>()

export function onPeopleSaved(listener: (people: VoicePerson[]) => void): () => void {
  saveListeners.add(listener)
  return () => saveListeners.delete(listener)
}

const people = async (): Promise<StoredPerson[]> => (await load()).people

export async function listVoicePeople(): Promise<VoicePerson[]> {
  return (await people()).map(toVoicePerson)
}

export async function listPeople(): Promise<Person[]> {
  return (await people()).map(toPerson)
}

export async function getPerson(id: string): Promise<Person | null> {
  const found = (await people()).find((person) => person.id === id)
  return found ? toPerson(found) : null
}

/** Where a sample came from and which model made it; see `SampleSource`. */
export type SampleOrigin = { source: SampleSource; sessionId: string | null; model?: string }

function newSample(vector: number[], origin: SampleOrigin): VoiceSample | null {
  // NaN would be written as null and the person could no longer be read.
  if (!vector.length || !vector.every(Number.isFinite)) return null
  return {
    vector,
    model: origin.model ?? SPEAKER_EMBEDDING.model,
    dims: vector.length,
    source: origin.source,
    sessionId: origin.sessionId,
    createdAt: new Date().toISOString()
  }
}

export async function addPerson(
  name: string,
  embedding: number[],
  self: boolean,
  origin: SampleOrigin = { source: 'enrolled', sessionId: null }
): Promise<Person> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A name is required')
  const sample = newSample(embedding, origin)
  if (!sample) throw new Error('That voice sample could not be used')
  const person: StoredPerson = {
    id: randomUUID(),
    name: trimmed,
    self,
    createdAt: new Date().toISOString(),
    samples: [sample]
  }
  await mutate((list) => {
    // Only one person can be "me".
    const others = self ? list.map((entry) => ({ ...entry, self: false })) : list
    return { people: [...others, person], result: null }
  })
  log('voices', 'added person', { id: person.id, self, source: origin.source })
  return toPerson(person)
}

export async function addSample(id: string, embedding: number[], origin: SampleOrigin): Promise<void> {
  const sample = newSample(embedding, origin)
  if (!sample) {
    log('voices', 'skipped an unusable sample', { id, dims: embedding.length })
    return
  }
  const added = await mutate((list) => {
    const person = list.find((entry) => entry.id === id)
    if (!person) return null
    const next = addSampleTo(person, sample)
    if (next === person) return null
    return { people: list.map((entry) => (entry.id === id ? next : entry)), result: next.samples.length }
  })
  log('voices', added === null ? 'sample not kept' : 'learned sample', {
    id,
    source: origin.source,
    samples: added
  })
}

export async function renamePerson(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A name is required')
  await mutate((list) => ({
    people: list.map((person) => (person.id === id ? { ...person, name: trimmed } : person)),
    result: null
  }))
}

/** Marks one person as "me", or nobody when `id` is null. */
export async function setSelf(id: string | null): Promise<void> {
  await mutate((list) => ({ people: list.map((person) => ({ ...person, self: person.id === id })), result: null }))
}

/** People deleted this run, kept in memory only so the window can undo the delete. */
const deleted = new Map<string, { person: StoredPerson; index: number }>()

/** Deletes the person and every voiceprint sample of theirs. */
export async function deletePerson(id: string): Promise<void> {
  await mutate((list) => {
    const index = list.findIndex((person) => person.id === id)
    const person = list[index]
    if (person) deleted.set(id, { person, index })
    return { people: list.filter((entry) => entry.id !== id), result: null }
  })
  log('voices', 'deleted person', { id })
}

/** Undoes `deletePerson`, back in the same place in the list. */
export async function restorePerson(id: string): Promise<void> {
  const entry = deleted.get(id)
  if (!entry) throw new Error('This person can no longer be restored')
  deleted.delete(id)
  await mutate((list) => {
    if (list.some((person) => person.id === id)) return null
    // Someone else may have become "me" since; they keep it.
    const takenSelf = list.some((person) => person.self)
    const person = { ...entry.person, self: entry.person.self && !takenSelf }
    return { people: [...list.slice(0, entry.index), person, ...list.slice(entry.index)], result: null }
  })
  log('voices', 'restored person', { id })
}

export type VoiceMatch = { person: Person; score: number }

/**
 * How close `embedding` (a current-model voiceprint) is to each saved voice, best first. Samples
 * from another model can't be compared and are skipped; the person is recognized again once
 * they're named in a session (which adds a sample). Samples taken from `sessionId` itself are
 * skipped too: a session must not vouch for its own speakers.
 */
export async function scoreVoices(embedding: readonly number[], sessionId: string | null): Promise<VoiceMatch[]> {
  const context = { model: SPEAKER_EMBEDDING.model, dims: embedding.length, sessionId }
  return (await people())
    .flatMap((person) => {
      const score = personScore(person, embedding, context)
      return score === null ? [] : [{ person: toPerson(person), score }]
    })
    .sort((a, b) => b.score - a.score)
}

export async function selfPerson(): Promise<Person | null> {
  const found = (await people()).find((person) => person.self)
  return found ? toPerson(found) : null
}

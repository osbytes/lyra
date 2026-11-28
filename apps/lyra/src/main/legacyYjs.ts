/**
 * Reads the `doc.yjs` files that Lyra wrote before sessions became plain data, so they can be
 * migrated without depending on Yjs. It's read-only and covers only what Lyra stored: the
 * v1 update format (lib0 encoding), Yjs's item ordering (YATA) for edits that two windows made
 * at once, delete sets, and maps, arrays and text nested inside each other. It's ported from
 * yjs 13.6 (`readClientsStructRefs`, `Item.getMissing`/`integrate`, `splitItem`,
 * `readAndApplyDeleteSet`). Pure, so it can be tested against logs written by yjs itself.
 *
 * The log is a list of frames, each a 4-byte little-endian length and then one update.
 */

import {
  NotesRun,
  type SessionDoc,
  type SpeakerEntry,
  type SpeakerMatch,
  type TranscriptSegment
} from '../shared/sessionDoc'
import { readEdits, rewriteLine } from '../shared/transcriptOverlay'

type ID = { client: number; clock: number }

type Content =
  | { kind: 'string'; str: string }
  | { kind: 'any'; values: unknown[] }
  | { kind: 'deleted'; length: number }
  | { kind: 'type'; type: YType }
  /** Binary, embeds, formatting and subdocuments: never used by Lyra, kept so lengths add up. */
  | { kind: 'other'; countable: boolean }

/** A shared type: a sequence (text, array) and a map, as Yjs's `AbstractType` holds both. */
type YType = { ref: number | null; start: Item | null; map: Map<string, Item>; item: Item | null }

type Parent = YType | ID | null

class Item {
  left: Item | null = null
  right: Item | null = null
  deleted: boolean
  constructor(
    public id: ID,
    public length: number,
    public origin: ID | null,
    public rightOrigin: ID | null,
    public parent: Parent,
    public parentSub: string | null,
    public content: Content
  ) {
    this.deleted = content.kind === 'deleted'
  }
  get lastId(): ID {
    return { client: this.id.client, clock: this.id.clock + this.length - 1 }
  }
}

class GC {
  constructor(
    public id: ID,
    public length: number
  ) {}
}

type Struct = Item | GC

/** A struct read from an update but not yet in the document. */
type Ref =
  | { kind: 'item'; item: Item }
  | { kind: 'gc'; id: ID; length: number }
  | { kind: 'skip'; id: ID; length: number }

// --- lib0 decoding ------------------------------------------------------------------

class Decoder {
  pos = 0
  private readonly view: DataView
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  done(): boolean {
    return this.pos >= this.bytes.length
  }
  uint8(): number {
    const value = this.bytes[this.pos++]
    if (value === undefined) throw new Error('Unexpected end of update')
    return value
  }
  varUint(): number {
    let num = 0
    let mult = 1
    for (;;) {
      const r = this.uint8()
      num += (r & 0x7f) * mult
      mult *= 128
      if (r < 0x80) return num
      if (mult > Number.MAX_SAFE_INTEGER) throw new Error('Integer out of range')
    }
  }
  varInt(): number {
    let r = this.uint8()
    let num = r & 0x3f
    let mult = 64
    const sign = (r & 0x40) > 0 ? -1 : 1
    if ((r & 0x80) === 0) return sign * num
    for (;;) {
      r = this.uint8()
      num += (r & 0x7f) * mult
      mult *= 128
      if (r < 0x80) return sign * num
      if (mult > Number.MAX_SAFE_INTEGER) throw new Error('Integer out of range')
    }
  }
  bytesOf(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) throw new Error('Unexpected end of update')
    const out = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }
  varString(): string {
    return new TextDecoder().decode(this.bytesOf(this.varUint()))
  }
  any(): unknown {
    const type = 127 - this.uint8()
    switch (type) {
      case 127 - 127:
        return undefined
      case 127 - 126:
        return null
      case 127 - 125:
        return this.varInt()
      case 127 - 124: {
        const value = this.view.getFloat32(this.pos, false)
        this.pos += 4
        return value
      }
      case 127 - 123: {
        const value = this.view.getFloat64(this.pos, false)
        this.pos += 8
        return value
      }
      case 127 - 122: {
        const value = this.view.getBigInt64(this.pos, false)
        this.pos += 8
        return Number(value)
      }
      case 127 - 121:
        return false
      case 127 - 120:
        return true
      case 127 - 119:
        return this.varString()
      case 127 - 118: {
        const length = this.varUint()
        const out: Record<string, unknown> = {}
        for (let i = 0; i < length; i++) {
          const key = this.varString()
          out[key] = this.any()
        }
        return out
      }
      case 127 - 117: {
        const length = this.varUint()
        const out: unknown[] = []
        for (let i = 0; i < length; i++) out.push(this.any())
        return out
      }
      case 127 - 116:
        return this.bytesOf(this.varUint()).slice()
      default:
        throw new Error('Unknown value type in update')
    }
  }
}

// --- Reading updates ------------------------------------------------------------------

const BITS5 = 31
const BIT6 = 32
const BIT7 = 64
const BIT8 = 128

/** Yjs's type refs: 0 array, 1 map, 2 text; the XML types carry a node name. */
const YXML_ELEMENT = 3
const YXML_HOOK = 5

function readContent(decoder: Decoder, info: number): Content {
  switch (info & BITS5) {
    case 1:
      return { kind: 'deleted', length: decoder.varUint() }
    case 2: {
      const length = decoder.varUint()
      const values: unknown[] = []
      for (let i = 0; i < length; i++) {
        const json = decoder.varString()
        const value: unknown = json === 'undefined' ? undefined : JSON.parse(json)
        values.push(value)
      }
      return { kind: 'any', values }
    }
    case 3:
      decoder.bytesOf(decoder.varUint())
      return { kind: 'other', countable: true }
    case 4:
      return { kind: 'string', str: decoder.varString() }
    case 5:
      decoder.varString()
      return { kind: 'other', countable: true }
    case 6:
      decoder.varString()
      decoder.varString()
      return { kind: 'other', countable: false }
    case 7: {
      const ref = decoder.varUint()
      if (ref === YXML_ELEMENT || ref === YXML_HOOK) decoder.varString()
      return { kind: 'type', type: newType(ref) }
    }
    case 8: {
      const length = decoder.varUint()
      const values: unknown[] = []
      for (let i = 0; i < length; i++) values.push(decoder.any())
      return { kind: 'any', values }
    }
    case 9:
      decoder.varString()
      decoder.any()
      return { kind: 'other', countable: true }
    default:
      throw new Error('Unknown content in update')
  }
}

const newType = (ref: number | null): YType => ({ ref, start: null, map: new Map(), item: null })

const contentLength = (content: Content): number =>
  content.kind === 'string'
    ? content.str.length
    : content.kind === 'any'
      ? content.values.length
      : content.kind === 'deleted'
        ? content.length
        : 1

/** The part of `content` from `offset` on; `content` keeps the part before it. */
function splice(content: Content, offset: number): Content {
  switch (content.kind) {
    case 'string': {
      let left = content.str.slice(0, offset)
      let right = content.str.slice(offset)
      // As Yjs does: a surrogate pair is never split, each half becomes U+FFFD.
      const code = left.charCodeAt(offset - 1)
      if (code >= 0xd800 && code <= 0xdbff) {
        left = `${left.slice(0, offset - 1)}�`
        right = `�${right.slice(1)}`
      }
      content.str = left
      return { kind: 'string', str: right }
    }
    case 'any': {
      const right = content.values.slice(offset)
      content.values = content.values.slice(0, offset)
      return { kind: 'any', values: right }
    }
    case 'deleted': {
      const right = { kind: 'deleted' as const, length: content.length - offset }
      content.length = offset
      return right
    }
    case 'type':
    case 'other':
      throw new Error('This content cannot be split')
  }
}

type Update = { refs: Map<number, Ref[]>; deletes: { client: number; clock: number; length: number }[] }

function readUpdate(bytes: Uint8Array, roots: Map<string, YType>): Update {
  const decoder = new Decoder(bytes)
  const refs = new Map<number, Ref[]>()
  const clients = decoder.varUint()
  for (let c = 0; c < clients; c++) {
    const count = decoder.varUint()
    const client = decoder.varUint()
    let clock = decoder.varUint()
    const list: Ref[] = []
    refs.set(client, list)
    for (let i = 0; i < count; i++) {
      const info = decoder.uint8()
      const id = { client, clock }
      if ((info & BITS5) === 0) {
        const length = decoder.varUint()
        list.push({ kind: 'gc', id, length })
        clock += length
        continue
      }
      if ((info & BITS5) === 10) {
        const length = decoder.varUint()
        list.push({ kind: 'skip', id, length })
        clock += length
        continue
      }
      const readId = (): ID => ({ client: decoder.varUint(), clock: decoder.varUint() })
      const origin = (info & BIT8) === BIT8 ? readId() : null
      const rightOrigin = (info & BIT7) === BIT7 ? readId() : null
      const ownParent = (info & (BIT7 | BIT8)) === 0
      let parent: Parent = null
      if (ownParent) {
        if (decoder.varUint() === 1) {
          const key = decoder.varString()
          let root = roots.get(key)
          if (!root) {
            root = newType(null)
            roots.set(key, root)
          }
          parent = root
        } else {
          parent = readId()
        }
      }
      const parentSub = ownParent && (info & BIT6) === BIT6 ? decoder.varString() : null
      const content = readContent(decoder, info)
      const item = new Item(id, contentLength(content), origin, rightOrigin, parent, parentSub, content)
      list.push({ kind: 'item', item })
      clock += item.length
    }
  }
  const deletes: Update['deletes'] = []
  const deleteClients = decoder.varUint()
  for (let c = 0; c < deleteClients; c++) {
    const client = decoder.varUint()
    const count = decoder.varUint()
    for (let i = 0; i < count; i++) {
      const clock = decoder.varUint()
      deletes.push({ client, clock, length: decoder.varUint() })
    }
  }
  return { refs, deletes }
}

// --- The struct store -------------------------------------------------------------------

class Store {
  readonly clients = new Map<number, Struct[]>()

  state(client: number): number {
    const last = this.clients.get(client)?.at(-1)
    return last ? last.id.clock + last.length : 0
  }

  add(struct: Struct): void {
    let list = this.clients.get(struct.id.client)
    if (!list) {
      list = []
      this.clients.set(struct.id.client, list)
    }
    list.push(struct)
  }

  private index(list: Struct[], clock: number): number {
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const struct = list[mid]
      if (!struct) break
      if (clock < struct.id.clock) hi = mid - 1
      else if (clock >= struct.id.clock + struct.length) lo = mid + 1
      else return mid
    }
    throw new Error('Update refers to an item that is not in the document')
  }

  private listOf(client: number): Struct[] {
    const list = this.clients.get(client)
    if (!list) throw new Error('Update refers to an item that is not in the document')
    return list
  }

  get(id: ID): Struct {
    const list = this.listOf(id.client)
    const struct = list[this.index(list, id.clock)]
    if (!struct) throw new Error('Update refers to an item that is not in the document')
    return struct
  }

  /** The struct starting at `id`, splitting the one that contains it. */
  cleanStart(id: ID): Struct {
    const list = this.listOf(id.client)
    const index = this.index(list, id.clock)
    const struct = list[index]
    if (!struct) throw new Error('Update refers to an item that is not in the document')
    if (struct instanceof Item && struct.id.clock < id.clock) {
      const right = split(struct, id.clock - struct.id.clock)
      list.splice(index + 1, 0, right)
      return right
    }
    return struct
  }

  /** The struct ending at `id`, splitting the one that contains it. */
  cleanEnd(id: ID): Struct {
    const list = this.listOf(id.client)
    const index = this.index(list, id.clock)
    const struct = list[index]
    if (!struct) throw new Error('Update refers to an item that is not in the document')
    if (struct instanceof Item && id.clock !== struct.id.clock + struct.length - 1) {
      list.splice(index + 1, 0, split(struct, id.clock - struct.id.clock + 1))
    }
    return struct
  }
}

function split(left: Item, diff: number): Item {
  const { client, clock } = left.id
  const right = new Item(
    { client, clock: clock + diff },
    left.length - diff,
    { client, clock: clock + diff - 1 },
    left.rightOrigin,
    left.parent,
    left.parentSub,
    splice(left.content, diff)
  )
  right.left = left
  right.right = left.right
  right.deleted = left.deleted
  left.right = right
  if (right.right) right.right.left = right
  const parent = right.parent
  if (right.parentSub !== null && right.right === null && parent && 'map' in parent) {
    parent.map.set(right.parentSub, right)
  }
  left.length = diff
  return right
}

const sameId = (a: ID | null, b: ID | null): boolean =>
  a === b || (a !== null && b !== null && a.client === b.client && a.clock === b.clock)

const isType = (parent: Parent): parent is YType => parent !== null && 'map' in parent

/**
 * The client whose item `item` needs and the document doesn't have yet, or null once it has
 * them all, when its neighbours and parent are resolved (`Item.getMissing`).
 */
function missing(item: Item, store: Store): ID | null {
  for (const id of [item.origin, item.rightOrigin, isType(item.parent) ? null : item.parent]) {
    if (id && id.client !== item.id.client && id.clock >= store.state(id.client)) return id
  }
  return null
}

function resolve(item: Item, store: Store): void {
  if (item.origin) {
    const left = store.cleanEnd(item.origin)
    item.origin = { client: left.id.client, clock: left.id.clock + left.length - 1 }
    item.left = left instanceof Item ? left : null
    if (left instanceof GC) {
      item.parent = null
      return
    }
  }
  if (item.rightOrigin) {
    const right = store.cleanStart(item.rightOrigin)
    item.rightOrigin = right.id
    item.right = right instanceof Item ? right : null
    if (right instanceof GC) {
      item.parent = null
      return
    }
  }
  if (!item.parent) {
    const from = item.left ?? item.right
    if (from) {
      item.parent = from.parent
      item.parentSub = from.parentSub
    }
  } else if (!isType(item.parent)) {
    const parentItem = store.get(item.parent)
    item.parent =
      parentItem instanceof Item && parentItem.content.kind === 'type' ? parentItem.content.type : null
  }
}

/** Puts a resolved item into its parent's sequence or map (`Item.integrate`). */
function integrate(item: Item, store: Store): void {
  const parent = item.parent
  if (!isType(parent)) {
    store.add(new GC(item.id, item.length))
    return
  }
  if (item.left ? item.left.right !== item.right : item.right?.left !== null) {
    let left = item.left
    let o: Item | null
    if (left !== null) o = left.right
    else if (item.parentSub !== null) {
      o = parent.map.get(item.parentSub) ?? null
      while (o !== null && o.left !== null) o = o.left
    } else o = parent.start
    const conflicting = new Set<Item>()
    const beforeOrigin = new Set<Struct>()
    while (o !== null && o !== item.right) {
      beforeOrigin.add(o)
      conflicting.add(o)
      if (sameId(item.origin, o.origin)) {
        if (o.id.client < item.id.client) {
          left = o
          conflicting.clear()
        } else if (sameId(item.rightOrigin, o.rightOrigin)) {
          break
        }
      } else if (o.origin !== null && beforeOrigin.has(store.get(o.origin))) {
        const originOf = store.get(o.origin)
        if (!(originOf instanceof Item) || !conflicting.has(originOf)) {
          left = o
          conflicting.clear()
        }
      } else {
        break
      }
      o = o.right
    }
    item.left = left
  }
  if (item.left !== null) {
    item.right = item.left.right
    item.left.right = item
  } else {
    let r: Item | null
    if (item.parentSub !== null) {
      r = parent.map.get(item.parentSub) ?? null
      while (r !== null && r.left !== null) r = r.left
    } else {
      r = parent.start
      parent.start = item
    }
    item.right = r
  }
  if (item.right !== null) item.right.left = item
  else if (item.parentSub !== null) parent.map.set(item.parentSub, item)
  store.add(item)
  if (item.content.kind === 'type') item.content.type.item = item
}

/**
 * Integrates every client's structs in clock order, each after the other clients' structs it
 * depends on. A struct whose dependencies never arrive (a log cut short) is left out, as Yjs
 * leaves it pending, along with everything its client wrote after it.
 */
function integrateAll(pending: Map<number, Ref[]>, store: Store): void {
  const next = new Map<number, number>()
  const blocked = new Set<number>()
  const peek = (client: number): Ref | undefined => pending.get(client)?.[next.get(client) ?? 0]
  const advance = (client: number): void => {
    next.set(client, (next.get(client) ?? 0) + 1)
  }
  for (const root of pending.keys()) {
    const stack: { client: number; until: number }[] = [{ client: root, until: Number.POSITIVE_INFINITY }]
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (!top) break
      const { client, until } = top
      const state = store.state(client)
      const ref = peek(client)
      if (state > until || !ref || blocked.has(client)) {
        stack.pop()
        // What the entry below waited for never came: it can't go on either.
        const below = stack[stack.length - 1]
        if (below && store.state(client) <= until) blocked.add(below.client)
        continue
      }
      const start = ref.kind === 'item' ? ref.item.id.clock : ref.id.clock
      const length = ref.kind === 'item' ? ref.item.length : ref.length
      if (start + length <= state) {
        advance(client)
        continue
      }
      if (start > state || ref.kind === 'skip') {
        blocked.add(client)
        continue
      }
      const offset = state - start
      if (ref.kind === 'gc') {
        store.add(new GC({ client, clock: state }, length - offset))
        advance(client)
        continue
      }
      const item = ref.item
      const need = missing(item, store)
      if (need) {
        if (stack.some((entry) => entry.client === need.client) || blocked.has(need.client)) {
          blocked.add(client)
        } else {
          stack.push({ client: need.client, until: need.clock })
        }
        continue
      }
      if (offset > 0) {
        item.id = { client, clock: state }
        item.origin = { client, clock: state - 1 }
        item.content = splice(item.content, offset)
        item.length -= offset
      }
      resolve(item, store)
      integrate(item, store)
      advance(client)
    }
  }
}

function applyDeletes(deletes: Update['deletes'], store: Store): void {
  for (const { client, clock, length } of deletes) {
    const list = store.clients.get(client)
    const end = Math.min(clock + length, store.state(client))
    if (!list || clock >= end) continue
    let struct = store.cleanStart({ client, clock })
    for (;;) {
      if (struct instanceof Item) {
        if (struct.id.clock + struct.length > end) store.cleanEnd({ client, clock: end - 1 })
        struct.deleted = true
      }
      const after = struct.id.clock + struct.length
      if (after >= end) break
      struct = store.get({ client, clock: after })
    }
  }
}

// --- Reading the document ------------------------------------------------------------------

const TYPE_ARRAY = 0
const TYPE_MAP = 1
const TYPE_TEXT = 2

function valueOf(item: Item): unknown {
  const content = item.content
  if (content.kind === 'any') return content.values.at(-1)
  if (content.kind === 'string') return content.str.at(-1)
  if (content.kind === 'type') return typeValue(content.type)
  return undefined
}

function typeValue(type: YType): unknown {
  if (type.ref === TYPE_ARRAY) return arrayOf(type)
  if (type.ref === TYPE_MAP) return mapOf(type)
  if (type.ref === TYPE_TEXT) return textOf(type)
  return null
}

function textOf(type: YType): string {
  let out = ''
  for (let item = type.start; item; item = item.right) {
    if (!item.deleted && item.content.kind === 'string') out += item.content.str
  }
  return out
}

function arrayOf(type: YType): unknown[] {
  const out: unknown[] = []
  for (let item = type.start; item; item = item.right) {
    if (item.deleted) continue
    const content = item.content
    if (content.kind === 'any') out.push(...content.values)
    else if (content.kind === 'string') {
      // One entry per UTF-16 unit, as Yjs reads text in an array.
      for (let i = 0; i < content.str.length; i++) out.push(content.str.charAt(i))
    }
    else if (content.kind === 'type') out.push(typeValue(content.type))
    else if (content.kind === 'other' && content.countable) out.push(null)
  }
  return out
}

function mapOf(type: YType): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of type.map) {
    if (!item.deleted) out[key] = valueOf(item)
  }
  return out
}

/** A document read from a log: its root types, read as the kind the caller knows them to be. */
export type LegacyDoc = {
  text: (name: string) => string
  map: (name: string) => Record<string, unknown>
  array: (name: string) => unknown[]
}

const clockOf = (ref: Ref): number => (ref.kind === 'item' ? ref.item.id.clock : ref.id.clock)

/** One frame per update: a 4-byte little-endian length, then the update. */
export function readFrames(buffer: Uint8Array): { frames: Uint8Array[]; end: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 4 <= buffer.byteLength) {
    const length = view.getUint32(offset, true)
    const end = offset + 4 + length
    // A torn last frame (crash mid-write) is dropped; everything before it is intact.
    if (end > buffer.byteLength) break
    frames.push(buffer.subarray(offset + 4, end))
    offset = end
  }
  return { frames, end: offset }
}

/**
 * Reads a `doc.yjs` log. `applied` counts the frames read; `damaged` is true when bytes were
 * left over (a torn write) or a frame couldn't be read, which, as before, stops the log there.
 */
export function readLegacyLog(bytes: Uint8Array): { doc: LegacyDoc; applied: number; damaged: boolean } {
  const { frames, end } = readFrames(bytes)
  const roots = new Map<string, YType>()
  const pending = new Map<number, Ref[]>()
  const deletes: Update['deletes'] = []
  let applied = 0
  for (const frame of frames) {
    let update: Update
    try {
      update = readUpdate(frame, roots)
    } catch {
      break
    }
    for (const [client, refs] of update.refs) {
      const list = pending.get(client) ?? []
      list.push(...refs)
      pending.set(client, list)
    }
    deletes.push(...update.deletes)
    applied++
  }
  // Frames repeat structs (a full resync, a compaction); integration skips what it already has.
  for (const list of pending.values()) {
    list.sort((a, b) => clockOf(a) - clockOf(b))
  }
  const store = new Store()
  integrateAll(pending, store)
  applyDeletes(deletes, store)
  const root = (name: string): YType => roots.get(name) ?? newType(null)
  return {
    doc: {
      text: (name) => textOf(root(name)),
      map: (name) => mapOf(root(name)),
      array: (name) => arrayOf(root(name))
    },
    applied,
    damaged: end < bytes.byteLength || applied < frames.length
  }
}

// --- Lyra's document, as it was laid out in Yjs ----------------------------------------------

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

function legacyMatches(value: unknown): SpeakerMatch[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const { personId, score } = record(item)
    return typeof personId === 'string' && typeof score === 'number' && Number.isFinite(score)
      ? [{ personId, score }]
      : []
  })
}

function legacySegment(value: unknown): TranscriptSegment {
  const entry = record(value)
  const current = str(entry.text)
  const original = str(entry.original, current)
  const edited = entry.edited === true
  const stored = readEdits(entry.edits, original.length)
  // Lines edited before the overlay existed were typed over directly: read the change as one
  // correction, so they draw the same way.
  const edits = !stored.length && edited && current !== original ? rewriteLine(original, [], current) : stored
  return {
    id: str(entry.id),
    rawId: typeof entry.rawId === 'string' ? entry.rawId : null,
    start: num(entry.start),
    end: num(entry.end),
    cluster: typeof entry.cluster === 'string' ? entry.cluster : null,
    userCluster: entry.userCluster === true,
    text: current,
    original,
    edits,
    edited,
    confidence: numOrNull(entry.confidence)
  }
}

/**
 * A Yjs session document as plain data, read the way Lyra read it: a field of the wrong type
 * falls back to its default rather than failing the session. The live-transcription ranges of
 * documents from before transcript lines (`meta.liveRanges`) are dropped: their text stays in
 * the notes.
 */
export function legacySessionDoc(doc: LegacyDoc): SessionDoc {
  const meta = doc.map('meta')
  const speakers = Object.entries(record(meta.speakers)).map(([id, value]): SpeakerEntry => {
    const entry = record(value)
    return {
      id,
      name: str(entry.name, id),
      personId: typeof entry.personId === 'string' ? entry.personId : null,
      confirmed: entry.confirmed === true,
      confidence: numOrNull(entry.confidence),
      matches: legacyMatches(entry.matches),
      introduced: null
    }
  })
  const seq = meta.speakerSeq
  const run = NotesRun.safeParse(meta.notesRun)
  return {
    title: doc.text('title'),
    summary: doc.text('summary'),
    notes: doc.text('notes'),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    speakers,
    transcript: doc.array('transcript').map(legacySegment),
    speakerSeq: typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
    notesGenerated: typeof meta.notesGenerated === 'string' ? meta.notesGenerated : null,
    notesRun: run.success ? run.data : null
  }
}

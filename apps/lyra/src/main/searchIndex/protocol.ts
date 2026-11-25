import { z } from 'zod'
import { SearchQuery } from '../../shared/searchQuery'

/**
 * Messages between main and the index worker (a utilityProcess that owns the search database).
 * Both sides parse what they receive: the worker its requests, main each result. See
 * docs/SEARCH-INDEX.md.
 */

const Field = z.enum(['title', 'tags', 'summary', 'notes', 'transcript'])

export const EditRecord = z.object({
  kind: z.enum(['replace', 'delete', 'highlight']),
  start: z.number().int(),
  end: z.number().int(),
  text: z.string().nullable()
})

export const SegmentRecord = z.object({
  id: z.string(),
  rawId: z.string().nullable(),
  start: z.number(),
  end: z.number(),
  cluster: z.string().nullable(),
  confidence: z.number().nullable(),
  edited: z.boolean(),
  text: z.string(),
  original: z.string(),
  edits: z.array(EditRecord)
})

export const SpeakerRecord = z.object({
  cluster: z.string(),
  name: z.string(),
  personId: z.string().nullable(),
  confirmed: z.boolean(),
  confidence: z.number().nullable(),
  talkSeconds: z.number(),
  segments: z.number().int(),
  matches: z.array(z.object({ personId: z.string(), score: z.number() }))
})

export const PassageRecord = z.object({
  field: Field,
  segmentId: z.string().nullable(),
  cluster: z.string().nullable(),
  start: z.number().nullable(),
  text: z.string()
})

export const ActionItemRecord = z.object({
  owner: z.string().nullable(),
  task: z.string(),
  done: z.boolean()
})

/**
 * A stretch of a session embedded for semantic search: merged paragraphs, or a window of
 * transcript lines. `input` is what gets embedded (the text; the session's first chunk also
 * leads with its title); `hash` is its sha256, which keys the vector so unchanged text is never
 * embedded twice.
 */
export const ChunkRecord = z.object({
  field: z.enum(['summary', 'notes', 'transcript']),
  segmentId: z.string().nullable(),
  cluster: z.string().nullable(),
  start: z.number().nullable(),
  end: z.number().nullable(),
  text: z.string(),
  input: z.string(),
  hash: z.string()
})
export type ChunkRecord = z.infer<typeof ChunkRecord>

/** Everything the index holds about one session, built in main from its manifest and document. */
export const SessionRecord = z.object({
  id: z.string(),
  title: z.string(),
  titleAuto: z.boolean(),
  preview: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  updatedAt: z.string(),
  seconds: z.number().nullable(),
  audio: z.enum(['none', 'kept', 'deleted']),
  words: z.number().int(),
  exportHash: z.string().nullable(),
  /** Compared with the manifest at startup: a different key means the row is stale. */
  indexKey: z.string(),
  tags: z.array(z.string()),
  tracks: z.array(z.object({ name: z.enum(['mic', 'system']), sampleRate: z.number(), seconds: z.number() })),
  passes: z.array(
    z.object({ id: z.string(), kind: z.enum(['live', 'diarized']), model: z.string(), createdAt: z.string() })
  ),
  speakers: z.array(SpeakerRecord),
  segments: z.array(SegmentRecord),
  actionItems: z.array(ActionItemRecord),
  passages: z.array(PassageRecord),
  chunks: z.array(ChunkRecord)
})
export type SessionRecord = z.infer<typeof SessionRecord>

export const PersonRecord = z.object({
  id: z.string(),
  name: z.string(),
  self: z.boolean(),
  createdAt: z.string(),
  voiceprints: z.array(z.array(z.number()))
})
export type PersonRecord = z.infer<typeof PersonRecord>

export const IndexStats = z.object({
  sessions: z.number().int(),
  segments: z.number().int(),
  speakers: z.number().int(),
  passages: z.number().int(),
  people: z.number().int(),
  chunks: z.number().int(),
  /** Chunks with a vector in the current embedder's space. */
  embedded: z.number().int(),
  /** Why background embedding last stopped, if it did. */
  embedError: z.string().nullable()
})
export type IndexStats = z.infer<typeof IndexStats>

/** One passage that matched, with the matched words between \u0001 and \u0002. */
export const PassageHit = z.object({
  field: Field,
  marked: z.string(),
  segmentId: z.string().nullable(),
  speaker: z.string().nullable(),
  start: z.number().nullable(),
  relevance: z.number()
})
export type PassageHit = z.infer<typeof PassageHit>

/** A matching session: its list-view summary, how well it matched (higher is better), and why. */
export const SessionHit = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  preview: z.string(),
  tags: z.array(z.string()),
  speakers: z.number().int(),
  startedAt: z.string(),
  seconds: z.number().nullable(),
  relevance: z.number(),
  passages: z.array(PassageHit)
})
export type SessionHit = z.infer<typeof SessionHit>

export const IndexRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('search'), query: SearchQuery, limit: z.number().int().positive() }),
  /** Opens (or creates) the database for a notes folder; another folder's index is dropped. */
  z.object({ type: z.literal('open'), path: z.string(), notesDir: z.string() }),
  z.object({ type: z.literal('upsertSession'), session: SessionRecord }),
  /** Which embedder fills in vectors and embeds queries; null turns semantic search off. */
  z.object({
    type: z.literal('setEmbedder'),
    embedder: z.discriminatedUnion('kind', [
      /** `sha256` is the model file's pinned hash: it names the embedding space. */
      z.object({ kind: z.literal('llama'), modelPath: z.string(), sha256: z.string() }),
      z.object({ kind: z.literal('hash') })
    ]).nullable()
  }),
  /** Waits until every chunk has a vector (tests); runs even while paused. */
  z.object({ type: z.literal('drainEmbeddings') }),
  /** Holds background embedding (recording, on battery); searches still embed their query. */
  z.object({ type: z.literal('setPaused'), paused: z.boolean() }),
  /**
   * Drops vectors no chunk uses and other spaces' vectors. Main sends it after a complete
   * reconcile, so a rebuild in progress never loses vectors it's about to reuse.
   */
  z.object({ type: z.literal('pruneEmbeddings') }),
  z.object({ type: z.literal('removeSession'), id: z.string() }),
  z.object({ type: z.literal('replacePeople'), people: z.array(PersonRecord) }),
  /** Each indexed session's `indexKey`, by id. */
  z.object({ type: z.literal('indexKeys') }),
  /** A session as the index holds it, rebuilt from its rows; for checks. */
  z.object({ type: z.literal('readSession'), id: z.string() }),
  z.object({ type: z.literal('readPeople') }),
  z.object({ type: z.literal('stats') }),
  z.object({ type: z.literal('close') })
])
export type IndexRequest = z.infer<typeof IndexRequest>

export const IndexEnvelope = z.object({ id: z.number().int(), request: IndexRequest })
export type IndexEnvelope = z.infer<typeof IndexEnvelope>

export const IndexResponse = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.string() })
])
export type IndexResponse = z.infer<typeof IndexResponse>

/**
 * What `open` reports: whether the index was (re)created and so needs a full reindex, and
 * whether that was because the old file was damaged (it's kept beside it as `*.corrupt-<time>`).
 */
export const OpenResult = z.object({ fresh: z.boolean(), recovered: z.boolean() })

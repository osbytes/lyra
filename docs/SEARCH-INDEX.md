# Search index (libSQL) and semantic search

Status: Phase 1 implemented (2026-11-24); Phases 2 and 3 follow in stacked PRs.

A local libSQL database that mirrors everything Lyra persists about sessions and people, so the app
can search by text, meaning, speaker, person, tag and date in one query. It's the base for
semantic search, and later for "Ask your notes".

## Decisions

- **The database is an index, not the source of truth.** Notes stay plain files, the Yjs
  document (`doc.yjs`) stays the authority for a session, and `voices.json` for people (see
  [SESSION-MODEL.md](SESSION-MODEL.md)). Every row can be rebuilt from files, so deleting
  the database loses nothing. This keeps the local-first contract: the notes folder is still
  something you can open, grep and sync.
- **It lives in `userData/index/lyra.db`, not the notes folder.** Sync tools (Dropbox, iCloud,
  OneDrive) corrupt live SQLite files, and the notes folder may be synced. The `meta` table
  records which notes folder it indexes; a different folder means a rebuild.
- **Local only.** `@libsql/client` with a `file:` URL. No Turso Cloud, no embedded replicas, no
  sync: those would send note text and embeddings off the device.
- **One writer, off the main thread.** The database and the embedding model run in a new
  `utilityProcess`, `indexWorker`, like `speakerWorker` and `notesWorker`. Main sends it
  snapshots and queries over a typed protocol. A vector scan takes tens of ms; that must not block
  main.
- **Settings, API keys, the overlay position, logs and model files are not indexed.** Keys never
  touch the database.

## What we verified (2026-11-24, Windows x64, `@libsql/client` 0.18.0 / `libsql` 0.5.29)

| Check | Result |
| --- | --- |
| Loads in Electron 42.11.18 (`ELECTRON_RUN_AS_NODE`) without a rebuild | Yes (N-API prebuilds) |
| SQLite version | 3.45.1 |
| FTS5 with `porter unicode61`, `bm25()`, `highlight()` | Works |
| FTS5 `trigram` tokenizer (substring match: `illo` → "Dillon") | Works |
| JSON functions | Work |
| `F32_BLOB`, `vector32()`, `vector_distance_cos`, `libsql_vector_idx`, `vector_top_k` | Work |
| Binding a `Buffer`/`Uint8Array` parameter through the sync `libsql` API (`stmt.run(buf)`) | **Rust panic; the process aborts, can't be caught.** `@libsql/client` binds `ArrayBuffer`/`Uint8Array` fine. Use only `@libsql/client`, and keep a smoke case that binds a blob |
| Exact vector scan, 256-d, `ORDER BY vector_distance_cos LIMIT 30` | 5 ms @ 1k rows, 22 ms @ 5k, 40 ms @ 10k, ~200 ms @ 50k |
| DiskANN index (`compress_neighbors=float8, max_neighbors=32`), query | ~13 ms at any size tested |
| DiskANN, cost per inserted row | **~13 ms/row**; building it over 50k existing rows took >10 min |
| DiskANN, size | 116 MB for 10k 256-d rows (the raw vectors are ~10 MB) |
| Deleting the db file right after `close()` on Windows | `EBUSY` once; don't rely on deleting the file to rebuild |

Prebuilt binaries exist for every platform Lyra ships (win32-x64, darwin-arm64/x64, linux-x64/arm64
gnu); there is no win32-arm64 build.

**Consequence: no DiskANN index to start.** A personal notebook is thousands to tens of thousands
of chunks; an exact scan is fast enough there, is exact, adds nothing per insert, and can be
narrowed first by SQL filters (person, tag, date), which makes it faster still. Add
`libsql_vector_idx` only if real libraries pass ~50k chunks, and build it in the background.

## What gets indexed

Sources, from the persistence inventory:

| Source | Where | Indexed as |
| --- | --- | --- |
| Manifest (`session.json`, `Manifest` in `sessionStore.ts`) | `.sessions/<id>/` | `sessions`, `tracks`, `passes` |
| Yjs document (`sessionDoc.ts`): title, notes, summary, tags, speakers, transcript segments and their edits | `.sessions/<id>/doc.yjs` | `sessions`, `tags`, `speakers`, `speaker_matches`, `segments`, `segment_edits`, `passages`, `chunks` |
| Summary text (rendered `MeetingNotes`) | in the doc | `action_items`, parsed from `- [ ] Owner: task` lines (structured notes aren't stored; see Phase 4) |
| People (`voices.json`, `StoredPerson`) | `userData` | `people`, `voiceprints` |
| Raw passes (`raw/*.json`): words, clusters, live trace | `.sessions/<id>/raw/` | Not indexed. Word timings stay in the JSON; the trace is for debugging |
| Audio | `.sessions/<id>/audio/` | Only metadata (`tracks`) |

## Schema

The statements are in [`src/main/searchIndex/schema.ts`](../apps/lyra/src/main/searchIndex/schema.ts)
(`SCHEMA_VERSION` 1). In short:

| Table | One row per | Notes |
| --- | --- | --- |
| `meta` | setting | `schema_version`, `notes_dir` |
| `sessions` | session | title, preview, dates, length, audio status, word count, export hash, `index_key` (the manifest's `updatedAt`) |
| `tags`, `tracks`, `passes` | tag, audio track, transcription pass | |
| `speakers`, `speaker_matches` | speaker in a session, saved voice it matched | `person_id` has no foreign key: sessions keep a deleted person's id |
| `segments`, `segment_edits` | transcript line, edit over it | edits are UTF-16 offsets into `original` |
| `action_items` | `- [ ] Owner: task` line of the generated notes | |
| `people`, `voiceprints` | person, voiceprint sample | voiceprints are float32 BLOBs (their length depends on the speaker model) |
| `passages` + `passages_fts` + `passages_tri` | title, tag, paragraph, transcript line | FTS5 external-content tables (stems; trigrams), kept current by triggers |
| `chunks`, `embeddings` | (Phase 3) | |

Rules:
- Every child row has `n`, its position in the document, so a session reads back in order.
- Times inside a session are seconds (`*_sec`); dates are ISO strings.
- Children are written with `json_each` (one statement per table) inside one `batch` transaction.
- Deletes are explicit, children first, rather than relying on `ON DELETE CASCADE`.
  `@libsql/client` can hand a connection to a transaction and open another, and `foreign_keys`
  is per connection.

Migrations: a different `SCHEMA_VERSION` or notes folder drops every table (triggers, then FTS
tables, then the rest) and the app reindexes. Since the database is derived, nothing migrates in
place. Rebuilds drop and recreate tables rather than deleting the file (the Windows `EBUSY` above).

## Keeping it in sync

`sessionStore.ts` emits `onSessionChange` events (`saved` at the end of `writeExport`, `removed`, `restored`) and `voices.ts` emits `onPeopleSaved`; `searchIndex/service.ts` subscribes:

| Event | Hook | Index action |
| --- | --- | --- |
| A session's content is saved | end of `writeExport` (~:679), which already has the snapshot and manifest | `upsertSession(snapshot, manifest)`, debounced per id |
| Manifest-only change (tracks, passes, audio deleted) | `updateManifest` (:1006) schedules an export | covered by the row above |
| Session created / migrated / dropped in | `createSession`, `migrateNote`, a new file seen by `listSessions` | covered by the export, plus the startup reconcile |
| Session deleted | `deleteSession` (:854) | `removeSession(id)` |
| Deletion undone | `restoreSession` (:906) | reindex the id |
| People changed | `voices.ts` `save` (:50) | replace `people` and `voiceprints` |
| Notes folder changed or moved | `onSettingsChanged`, `moveNotes` | `notes_dir` differs → rebuild |
| Startup | `index.ts` ~:316, after migrations | reconcile in the background: `listSessions()` vs `sessions.index_key`; index stale or missing ids, delete ids that are gone |
| Quit | `shutdownWork` (`index.ts:334`) | flush the queue, close the database, stop the worker |

`upsertSession` runs in one transaction: delete the session's rows, insert them again. A session is
small (hundreds of rows), so this is simpler and safer than diffing. Chunks whose `hash` already
has an embedding for the current model keep it; the rest go on the embedding queue.

The live transcriber updates the document many times a second; the per-id debounce (1.5 s) and the
export debounce keep that from reindexing on every word.

## Chunking

- **Passages** (keyword search, highlights, jump-to-line) copy `search.ts`: title, each tag, each
  paragraph of summary and notes, each transcript segment.
- **Chunks** (embeddings): summary and notes paragraphs merged up to ~250 tokens; the transcript as
  windows of consecutive segments up to ~45 s or ~250 tokens with one segment of overlap, keeping
  `start`, the first segment id and the speakers. Lines like "yeah" or "ok" alone embed as noise.
  The session title is prepended to each chunk's text before embedding (not stored in `text`).

## Embeddings

- `node-llama-cpp` (already shipped for local notes) in `indexWorker`, loaded the way
  `notesWorker.ts` loads it (the `--packaged` resources path).
- Model: `nomic-embed-text-v1.5` GGUF, Q8_0, pinned as a `ModelFile` and downloaded with
  `ensureModelFile`. Use its Matryoshka property: keep the first 256 dimensions, renormalise.
  Prefixes `search_document: ` and `search_query: `.
- On by default only once the model is downloaded; until then search is keyword only. A setting
  "Semantic search" (the `add-setting` skill) triggers the download; status reported like
  `WhisperStatus`.
- The queue embeds in batches at low priority and pauses while a recording or meeting pipeline
  runs, so it never competes with Whisper.
- Changing the model changes `embed_model`; old embeddings are ignored and replaced in the
  background.

## Querying

One search entry point in the worker; `searchSessions` in main becomes a thin call to it.

```ts
type SearchQuery = {
  text: string
  people?: string[]          // person ids
  speakers?: string[]        // speaker names, for unnamed or unmatched voices
  tags?: string[]
  from?: string; to?: string // started_at range
  fields?: SearchField[]
}
```

1. **Filter** in SQL to the candidate sessions (joins on `tags`, `speakers`, `sessions`).
2. **Keyword:** `passages_fts MATCH` (word and stem matches, `bm25` with the current field boosts)
   unioned with `passages_tri` for partial words. Highlights from `highlight()`.
3. **Semantic:** embed the query, exact `vector_distance_cos` scan over `chunks JOIN embeddings`
   restricted to the candidates, top 50.
4. **Merge** per session with reciprocal rank fusion (k = 60). Each hit keeps its best few
   passages; a semantic-only match shows its chunk as one un-highlighted run, which
   `SearchMatch.parts` already supports.

The command palette gains filter tokens (`person:dillon`, `tag:design`, `after:2026-11-01`) parsed
in the renderer into `SearchQuery`. The query shape crosses IPC, so it's one zod schema, and the
channel follows the `add-ipc-channel` skill. The keyword results return first; semantic results
fold in when ready, so typing stays as fast as today.

Fuse.js stays until FTS5 matches it on a fixed set of queries, including typos (Phase 2). Trigram
covers partial words but not misspellings; if typo tolerance matters, keep Fuse over the
candidate passages that FTS returns, or add a spelling pass with the `fts5vocab` table.

## Packaging

- `@libsql/client` in `dependencies` (it brings `libsql` and the `@libsql/<platform>` prebuilds).
- Add it to `rollupOptions.external` in `electron.vite.config.ts`, and an `indexWorker` input.
- `asarUnpack` already unpacks `**/*.node`; check `pnpm build:unpack` on Windows and macOS that the
  platform package lands (the hoisted pnpm layout has bitten node-llama-cpp; if it bites here,
  ship it the way `prepare-llama.cjs` ships node-llama-cpp).
- `pnpm smoke` gets a native check: open a database in Electron, bind a `Float32Array` blob, run an
  FTS5 and a vector query.

## Phases

Each phase ships on its own and leaves the app working.

1. **Index worker and schema.** `indexWorker` with `@libsql/client`, the v1 schema, the protocol
   (zod schemas for every message), the sync hooks and the startup reconcile. Index sessions,
   speakers, segments, tags, people, passages and action items. Search still uses Fuse; the index
   is only written. `checkSearchIndex()` (in `searchIndex/service.ts`) reads every session and person back
   from the database and compares it with the files; the UI smoke test runs it after each step.
   Done when: the smoke test creates, edits, deletes, restores sessions and renames a person,
   and the index matches; a rebuild of a few hundred sessions takes seconds.
2. **Keyword search on the index.** `searchSessions` uses FTS5 plus filters; add the palette
   filter tokens and "sessions with this person" (People settings and speaker labels). A golden
   query set (`pnpm eval:search`, fixture sessions with expected hits) compares it to Fuse
   before Fuse is removed.
3. **Semantic search.** Chunks, embeddings queue, the setting and model download, hybrid
   ranking. Extend `pnpm eval:search` with paraphrased queries; report recall@5 for keyword alone
   and for hybrid.
4. **Later, each optional:**
   - Store `MeetingNotes` as structured data in the doc instead of parsing the summary.
   - "Who is this voice?": compare an unnamed speaker's voiceprint to `voiceprints` and past
     speakers across sessions.
   - "Ask your notes": retrieval through the hybrid search, answered by the existing
     `NotesWriter` (local or cloud), citing sessions and lines.
   - A DiskANN index, only if real libraries pass ~50k chunks.

## Verification for every phase

- `pnpm check`, `pnpm smoke:ui` (new `runUiSmoke` cases for each IPC the renderer can reach), and
  `pnpm smoke` (native load and blob binding).
- `pnpm build:unpack` on Windows and macOS, launch the packaged app, search.
- The log records counts and timings only (rows indexed, ms per query), never text or queries.

## Open questions

- Should `voices.json` eventually move into the database as the source of truth? It's rewritten
  whole on every change and would benefit, but it would make the database something you can't
  delete. Not in this plan.
- Typo tolerance: keep Fuse as a second pass, or accept FTS5 plus trigram? Decide on the Phase 2
  eval results.
- English only: Whisper runs `base.en`, so an English embedding model is fine for now. A
  multilingual model (Qwen3-Embedding-0.6B, ~640 MB) fits the same slot if that changes.

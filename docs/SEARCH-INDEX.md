# Search index (libSQL) and semantic search

Status: Phases 1–3 implemented (2026-11-24), as three stacked PRs.

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
(`SCHEMA_VERSION` 4). In short:

| Table | One row per | Notes |
| --- | --- | --- |
| `meta` | setting | `schema_version`, `notes_dir` |
| `sessions` | session | title, preview, dates, length, audio status, word count, export hash, `index_key` (the manifest's `updatedAt`) |
| `tags`, `tracks`, `passes` | tag, audio track, transcription pass | |
| `speakers`, `speaker_matches` | speaker in a session, saved voice it matched | `person_id` has no foreign key: sessions keep a deleted person's id |
| `segments`, `segment_edits` | transcript line, edit over it | edits are UTF-16 offsets into `original` |
| `action_items` | `- [ ] Owner: task` line of the generated notes | |
| `people`, `voiceprints` | person, voiceprint sample | voiceprints are float32 BLOBs (their length depends on the speaker model) |
| `passages` + `passages_fts` + `passages_tri` | title, tag, paragraph, transcript line | FTS5 external-content tables (stems; trigrams), kept current by triggers; both fold diacritics |
| `chunks` | chunk of text to embed | `hash` is the sha256 of what gets embedded |
| `embed_queue` | chunk waiting for a vector in the current embedding space | `priority` is the session's `updated_at`; indexed, so the next batch is an index read |
| `vectors`, `vector_meta` | vector per (text hash, embedding space) | `embedding` is `F32_BLOB(768)`; no vector index. Survives rebuilds (below) |

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

**Vectors are kept through a rebuild.** Reindexing 10k sessions takes seconds; re-embedding them
takes hours of CPU. So `vectors` and `vector_meta` are left out of the drop, and have their own
version (`VECTOR_STORE_VERSION` in `schema.ts`, stored in `vector_meta`); only a change to that
drops them. A vector is keyed by its text's hash and its embedding space, never by session or
notes folder, so the reindex after a schema bump or a moved notes folder finds its vectors again
and embeds only text it hasn't seen. An older build (any `SCHEMA_VERSION` 3 or lower) drops
everything, vectors included, on downgrade; upgrading again starts the vectors over.

They're a table in the same file rather than an attached database: `@libsql/client` keeps a pool
of connections and opens new ones as it needs them (a `batch` or transaction may get a fresh one),
and `ATTACH` is per connection, so an attached file would vanish from some queries. One file also
keeps a write to the queue and a write of the vector it pays off in one transaction.

**A damaged file is rebuilt** (`searchIndex/openIndex.ts`). Opening runs `PRAGMA quick_check`;
a file that won't open, fails the check or fails to prepare is closed and moved aside with its
WAL files as `lyra.db*.corrupt-<time>` (only the newest such set is kept), and a fresh database
is made and filled by the reconcile. Errors that say nothing about the file (busy, locked, disk
full, no permission) are left to a retry instead, since moving the file would lose its vectors.

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
has a vector in the current embedding space keep it; the rest go on the embedding queue.

The live transcriber updates the document many times a second; the per-id debounce (1.5 s) and the
export debounce keep that from reindexing on every word. A `saved` event queues how to build the
record, not the record: chunking and hashing run once, when the debounced write fires. The
startup reconcile handles one session per turn of the event loop (`setImmediate`) so a rebuild
of thousands of sessions doesn't hold up recording IPC; decoding each `doc.yjs` still happens on
the main thread. Moving that decode into the worker is the end state, but the worker would then
need the session store's file layout and frame reader, which import Electron; not done yet.

**Failures.** A session write that fails is queued again (three tries, 2 s apart and growing)
unless a newer change replaced it. A failed open, or a worker that exits without being asked,
is restarted after a backoff (2 s, doubling, at most 5 min; a worker that ran a minute resets
it), and the reconcile runs again then, since writes in flight were lost. After six failed starts
in a row the index stays off until the next launch; Lyra works without it. Calls made during the
backoff fail at once instead of forking a worker each.

## Chunking

- **Passages** (keyword search, highlights, jump-to-line): the title, each tag, each paragraph of
  summary and notes, each transcript segment.
- **Chunks** (embeddings, `chunksOf` in `searchIndex/record.ts`):
  - Summary and notes paragraphs are merged up to 1,000 characters (about 250 tokens).
  - The transcript is cut into windows of consecutive lines, written `Name: text`, of up to
    1,000 characters or 45 s. Each window repeats the previous window's last line, so a thought
    that spans the cut is whole in one of them. Each window keeps its first line's id and start
    time, so a hit jumps there.
  - What gets embedded (`input`) is the chunk's text; the session's first chunk also leads with
    the title. Only one: auto-titles land after the first minutes of a recording, and a rename
    should re-embed one chunk, not the whole session. Its sha256 keys the vector, so unchanged
    text is never embedded twice, even when a session is reindexed.

## Embeddings

- `node-llama-cpp` (already shipped for local notes) runs in the index worker, loaded through
  `src/main/llamaModule.ts`. The notes worker uses the same loader, which also removed a cast
  from it.
- Model: `nomic-embed-text-v1.5` GGUF Q8_0 (Apache-2.0, 146,146,432 bytes), pinned to a
  Hugging Face revision and hash as a `ModelFile` and downloaded with `ensureModelFile`. It uses
  the prefixes `search_document: ` and `search_query: `.
- **768 dimensions, not 256.** We measured it on paraphrased questions against a handful of notes
  ("teeth checkup" → a dentist note, "vehicle maintenance" → "new tires and an oil change"):
  - Full vectors ranked the right note first for 5 of 6 queries and separated it from the rest
    better than Matryoshka-256 did.
  - The right note scored 0.54–0.67; unrelated notes scored 0.40–0.53.
  - So a chunk counts only if it scores at least 0.5 *and* within 0.05 of the best chunk for
    that query.
  - An exact scan at 768-d costs about 3× the 256-d timings above, which is still fine at
    notebook scale.
- **Embedding space.** A vector is stored under its space: the model file's pinned sha256 (not
  its name), the dimensions, and `EMBED_RECIPE` (`embedder.ts`), a constant bumped whenever the
  task prefixes or the chunking change. A change to any of them re-embeds instead of comparing
  vectors made two different ways.
- **The "Search by meaning" setting** (`semanticSearch`, off by default) downloads the model the
  first time and loads it in the worker. Turning it off unloads the model and keeps the vectors.
- **Background work.**
  - The worker embeds one chunk at a time between requests, about 0.2 s per chunk on CPU with
    2 threads, so a search waits for at most one.
  - The backlog is `embed_queue`, most recently updated session first, so the note being
    worked on is searchable by meaning before last year's. It's filled as sessions are written
    and refilled from `chunks` whenever the embedder changes.
  - `setIndexBusy('recording' | 'battery', on)` (`searchIndex/service.ts`) holds the backlog
    while a recording runs or the machine is on battery; searches still embed their query. The
    2-thread limit still applies when it runs.
  - Vectors no chunk uses any more, and other spaces' vectors, are pruned at the end of a
    reconcile that indexed every session, not when the backlog empties: mid-rebuild, the
    sessions that will reuse a vector may not be back yet.
- **Tests.** The UI smoke test swaps in a word-hashing stand-in (`createHashEmbedder`), so it
  exercises chunking, embedding, the vector scan and fusion without the download. The real
  model was checked by hand (see the PR).

## Querying

The search box still sends one string over IPC (`searchPages`). Main parses it with
`parseSearchQuery` (`src/shared/searchQuery.ts`, shared so the window can show what it understood):

| Filter | Matches |
| --- | --- |
| `person:ana`, `speaker:"Speaker 2"` | sessions where a speaker's name, or the saved person it's linked to, starts with the value (case-insensitive) |
| `tag:design` | sessions with that tag (normalised like tags are) |
| `after:2026-11`, `before:2026-12-01` | sessions that started in that range (ISO date prefixes; `after` inclusive) |

Then the worker (`searchIndex/query.ts`):

1. **Filter** sessions in SQL. With no words left, the result is the filtered sessions, newest first.
2. **Words** are letters and digits only (so nothing typed is FTS5 syntax). Each word matches as a
   prefix through the porter tokenizer (`"budg"*`, `"meetings"*` → `meet*`); every word must
   appear in the passage.
3. **Typos:** a word that matches nothing is respelled from the index's vocabulary
   (`passages_vocab`, an `fts5vocab` table, cached in the worker until the next write): words
   within one edit (two from seven letters), or stems within reach of the word cut to their
   length ("meetign" → "meet"); the three most common are ORed in.
4. **Parts of words:** when every word has three letters or more, the trigram table also matches
   them inside longer words ("illo" → "Dillon"), at half weight. It folds diacritics
   (`remove_diacritics 2`) as the word table and the query do, so "ajose" finds "Mariajosé".
5. **Rank:** a passage scores its field's weight (title 3, tags 2.5, summary 1.2, notes and
   transcript 1) plus its bm25; a session scores its best passage. The 2,000 passages read per
   query are cut by that same score in SQL, so a title match isn't pushed out by a common word. Each hit keeps its five best
   passages (titles aside), with the matched words marked by `highlight()`.

Pending index writes are flushed before each search, so a note saved a moment ago is found.

Fuse.js no longer searches notes; the command palette still uses it for its commands.

With semantic search on, the query is embedded too and an exact `vector_distance_cos` scan
over `chunks JOIN embeddings` (restricted to the filtered sessions) finds the closest chunks.
Both lists merge by reciprocal rank fusion (k = 60). A session found only by meaning shows its
closest chunk, unmarked and cut to its opening.

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
2. **Keyword search on the index.** `searchSessions` uses FTS5, typo correction, trigrams and
   the filters above. A golden query set in the UI smoke test (`checkSearchQueries`: ranking,
   stems, prefixes, typos, partial words, each filter, highlights) pins the behaviour; the
   renderer's existing typo case (`helo SMOKE`) still passes.
3. **Semantic search.** Chunks, the embedding pump, the setting and model download, and hybrid
   ranking. The smoke test runs it with the word-hashing stand-in; the real model was QA'd by hand.
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
- English only: Whisper runs `base.en`, so an English embedding model is fine for now. A
  multilingual model (Qwen3-Embedding-0.6B, ~640 MB) fits the same slot if that changes.

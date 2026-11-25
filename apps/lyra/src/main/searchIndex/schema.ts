/**
 * The search database's tables (docs/SEARCH-INDEX.md). The database is derived from the notes
 * folder and voices.json, so a schema change doesn't migrate: it drops every table and the app
 * reindexes. Bump SCHEMA_VERSION whenever these statements, or what a record holds, change.
 * The vector store (VECTOR_SCHEMA) is the exception: it survives that rebuild and has its own
 * version, since recomputing vectors takes hours where reindexing takes seconds.
 *
 * Children carry `n`, their position in the document, so a session reads back in order.
 * Times inside a session are seconds (`*_sec`); dates are ISO strings.
 */

export const SCHEMA_VERSION = 4

export const SCHEMA: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_auto INTEGER NOT NULL,
    preview TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    seconds REAL,
    audio TEXT NOT NULL,
    words INTEGER NOT NULL,
    export_hash TEXT,
    index_key TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  )`,
  `CREATE INDEX sessions_started ON sessions (started_at)`,

  `CREATE TABLE tags (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (session_id, n)
  )`,
  `CREATE INDEX tags_tag ON tags (tag)`,

  `CREATE TABLE tracks (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    name TEXT NOT NULL,
    sample_rate INTEGER NOT NULL,
    seconds REAL NOT NULL,
    PRIMARY KEY (session_id, n)
  )`,

  `CREATE TABLE passes (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, n)
  )`,

  `CREATE TABLE people (
    id TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    name TEXT NOT NULL,
    self INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // A plain BLOB of float32s, not F32_BLOB(n): its length depends on the speaker model.
  `CREATE TABLE voiceprints (
    person_id TEXT NOT NULL REFERENCES people ON DELETE CASCADE,
    n INTEGER NOT NULL,
    dims INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (person_id, n)
  )`,

  // No foreign key to people: a session keeps a person's id after the person is deleted.
  `CREATE TABLE speakers (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    name TEXT NOT NULL,
    person_id TEXT,
    confirmed INTEGER NOT NULL,
    confidence REAL,
    talk_sec REAL NOT NULL,
    segments INTEGER NOT NULL,
    PRIMARY KEY (session_id, cluster)
  )`,
  `CREATE INDEX speakers_person ON speakers (person_id)`,
  `CREATE INDEX speakers_name ON speakers (name COLLATE NOCASE)`,

  `CREATE TABLE speaker_matches (
    session_id TEXT NOT NULL,
    cluster TEXT NOT NULL,
    n INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (session_id, cluster, n),
    FOREIGN KEY (session_id, cluster) REFERENCES speakers (session_id, cluster) ON DELETE CASCADE
  )`,

  `CREATE TABLE segments (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    id TEXT NOT NULL,
    raw_id TEXT,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    cluster TEXT,
    confidence REAL,
    edited INTEGER NOT NULL,
    text TEXT NOT NULL,
    original TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  )`,
  `CREATE INDEX segments_order ON segments (session_id, n)`,
  `CREATE INDEX segments_cluster ON segments (session_id, cluster)`,

  // Offsets are UTF-16 code units into the segment's `original` (shared/transcriptOverlay.ts).
  `CREATE TABLE segment_edits (
    session_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    kind TEXT NOT NULL,
    from_char INTEGER NOT NULL,
    to_char INTEGER NOT NULL,
    text TEXT,
    PRIMARY KEY (session_id, segment_id, n),
    FOREIGN KEY (session_id, segment_id) REFERENCES segments (session_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE action_items (
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    n INTEGER NOT NULL,
    owner TEXT,
    task TEXT NOT NULL,
    done INTEGER NOT NULL,
    PRIMARY KEY (session_id, n)
  )`,

  // What keyword search matches: the title, each tag, paragraph and transcript line.
  `CREATE TABLE passages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    field TEXT NOT NULL,
    segment_id TEXT,
    cluster TEXT,
    start_sec REAL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX passages_session ON passages (session_id)`,
  // Words and stems, and any three letters in a row (partial words). Both index `passages`
  // without copying it; the triggers keep them current (sqlite.org/fts5.html, external content).
  `CREATE VIRTUAL TABLE passages_fts USING fts5(
    text, content='passages', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
  )`,
  // Folds diacritics like the word table and the query (query.ts, fold), so "jos" finds "José".
  `CREATE VIRTUAL TABLE passages_tri USING fts5(
    text, content='passages', content_rowid='id', tokenize='trigram remove_diacritics 2'
  )`,
  // Every distinct word (stemmed) and how many passages hold it: what typo correction picks from.
  `CREATE VIRTUAL TABLE passages_vocab USING fts5vocab(passages_fts, 'row')`,
  `CREATE TRIGGER passages_ai AFTER INSERT ON passages BEGIN
    INSERT INTO passages_fts (rowid, text) VALUES (new.id, new.text);
    INSERT INTO passages_tri (rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TRIGGER passages_ad AFTER DELETE ON passages BEGIN
    INSERT INTO passages_fts (passages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO passages_tri (passages_tri, rowid, text) VALUES ('delete', old.id, old.text);
  END`,
  `CREATE TRIGGER passages_au AFTER UPDATE ON passages BEGIN
    INSERT INTO passages_fts (passages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO passages_tri (passages_tri, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO passages_fts (rowid, text) VALUES (new.id, new.text);
    INSERT INTO passages_tri (rowid, text) VALUES (new.id, new.text);
  END`,

  // What semantic search compares: merged paragraphs and windows of transcript lines.
  `CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
    field TEXT NOT NULL,
    segment_id TEXT,
    cluster TEXT,
    start_sec REAL,
    end_sec REAL,
    text TEXT NOT NULL,
    input TEXT NOT NULL,
    hash TEXT NOT NULL
  )`,
  `CREATE INDEX chunks_session ON chunks (session_id)`,
  `CREATE INDEX chunks_hash ON chunks (hash)`,
  // Chunks still waiting for a vector in the current embedding space, by session, so the next
  // batch is an index read instead of a scan of every chunk. Newest sessions go first. It's
  // filled on upsert and refilled whenever the embedder changes (db.ts, refillEmbedQueue).
  `CREATE TABLE embed_queue (
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    priority TEXT NOT NULL,
    PRIMARY KEY (session_id, hash)
  )`,
  `CREATE INDEX embed_queue_priority ON embed_queue (priority)`,
  `CREATE INDEX embed_queue_hash ON embed_queue (hash)`
]

/** Bump when VECTOR_SCHEMA changes; that, and only that, drops the stored vectors. */
export const VECTOR_STORE_VERSION = 1

/** Tables a schema rebuild leaves alone (db.ts, prepare). */
export const PRESERVED_TABLES: readonly string[] = ['vector_meta', 'vectors']

export const VECTOR_SCHEMA: readonly string[] = [
  `CREATE TABLE vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Keyed by the embedded text's hash and the embedding space (model file hash, dimensions and
  // recipe; embedder.ts, embeddingSpace), not by chunk or notes folder: a reindex, a schema
  // bump or a moved notes folder keeps every vector whose text didn't change. No vector index:
  // an exact scan is fast enough at notebook scale (docs/SEARCH-INDEX.md, What we verified).
  `CREATE TABLE vectors (
    hash TEXT NOT NULL,
    space TEXT NOT NULL,
    embedding F32_BLOB(768) NOT NULL,
    PRIMARY KEY (hash, space)
  )`
]

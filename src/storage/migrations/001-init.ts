import type { Migration } from "./index.js";

// NOTE: this migration was previously edited IN PLACE while Cairn was
// unreleased (version 0.0.0), on the reasoning that no database built
// against an earlier shape of this file existed in the wild. That window is
// now closed: the repository is public and this schema has shipped in CI on
// three platforms, so a real database recording version 1 as applied can
// exist. From here on, every schema change is an additive migration file
// (see 002-redactions.ts, the first one) — never an edit to a migration
// that has already shipped.
const TABLES_DDL = `
CREATE TABLE episodes (
  -- seq is the real (AUTOINCREMENT) rowid: never reused, unlike the
  -- implicit rowid a TEXT-only primary key would get. See the comment on
  -- memories.seq below for why that matters.
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  content       TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'default',
  source_client TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
-- id (UUIDv7) is the deterministic tie-breaker for keyset pagination when
-- created_at values collide, same reasoning as idx_memories_scope_created.
CREATE INDEX idx_episodes_scope_created ON episodes(scope, created_at DESC, id DESC);
CREATE INDEX idx_episodes_created ON episodes(created_at DESC, id DESC);

CREATE TABLE memories (
  -- seq is the real (AUTOINCREMENT) rowid. memories_fts and the future
  -- vec0 tables are keyed off seq, not off the TEXT id: a plain
  -- an "id TEXT PRIMARY KEY" table has only an implicit rowid, and SQLite
  -- reuses implicit rowids after a hard delete (e.g. delete row at rowid 2,
  -- insert a new row, it gets rowid 2 back). Without AUTOINCREMENT, a
  -- purged memory's orphaned vec0 row would silently be inherited by the
  -- next inserted memory, and recall would return a semantic hit for
  -- content the user deleted — a privacy failure presented as a correct
  -- answer. AUTOINCREMENT guarantees seq is never reused, which also makes
  -- the old VACUUM-renumbering caveat moot.
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  text          TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'default',
  source_client TEXT,
  importance    REAL NOT NULL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count  INTEGER NOT NULL DEFAULT 0,
  valid_from    INTEGER NOT NULL,
  valid_until   INTEGER,
  -- ON DELETE SET NULL is for the successor's normal soft-delete/edit path.
  -- HAZARD: if the successor is instead HARD-PURGED (the §10 "delete
  -- everything" path), this column goes NULL while the predecessor's
  -- valid_until stays set — the predecessor is then permanently invisible
  -- to memories_live with no remaining record of why it expired (though
  -- audit_log still shows the supersession event). The purge path MUST
  -- remedy this itself: when nulling superseded_by via a hard purge, also
  -- clear valid_until on the rows that pointed at the purged id.
  superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
  episode_id    TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  deleted_at    INTEGER,
  redacted      INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL,
  CHECK (importance >= 0.0 AND importance <= 1.0),
  CHECK (redacted IN (0, 1))
);
-- HAZARD: "INSERT OR REPLACE INTO memories" is NOT the sanctioned upsert,
-- even with recursive_triggers=ON keeping the FTS index nominally correct.
-- REPLACE deletes-then-inserts the conflicting row, which (a) assigns it a
-- new seq, orphaning any vec0 row keyed by the old one, (b) cascades and
-- deletes its memory_tags rows, and (c) nulls out a predecessor's
-- superseded_by while leaving valid_until set, reproducing the
-- "permanently invisible predecessor" hazard documented below for hard
-- purge -- now reachable from an ordinary write. Use
-- "INSERT ... ON CONFLICT(id) DO UPDATE SET ..." instead: it preserves seq
-- and memory_tags, and fires memories_au so FTS updates correctly. The
-- partial-index conflict target
-- "ON CONFLICT(scope, content_hash) WHERE deleted_at IS NULL AND valid_until IS NULL"
-- also works, for dedupe-on-write.
-- Partial unique index: exact-duplicate text is rejected only among LIVE
-- memories in the same scope, so a superseded or soft-deleted fact can be
-- legitimately stated again (BUILD_BRIEF §5 supersede-not-delete).
CREATE UNIQUE INDEX idx_memories_live_hash ON memories(scope, content_hash)
  WHERE deleted_at IS NULL AND valid_until IS NULL;
-- id (a UUIDv7, time-ordered) is part of the ordering key, not just
-- created_at: a batch insert (e.g. an importer) can share one Date.now()
-- across many rows, and without a deterministic tie-breaker keyset
-- pagination over created_at alone skips or repeats rows on ties.
CREATE INDEX idx_memories_scope_created ON memories(scope, created_at DESC, id DESC);
CREATE INDEX idx_memories_created ON memories(created_at DESC, id DESC);
CREATE INDEX idx_memories_live ON memories(scope, deleted_at, valid_until);
CREATE INDEX idx_memories_superseded_by ON memories(superseded_by);
CREATE INDEX idx_memories_episode ON memories(episode_id);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);

-- Sanctioned way to search: soft-deleted (deleted_at) and superseded
-- (valid_until) rows deliberately REMAIN in memories_fts, because
-- memories_au only fires on UPDATE OF text and soft-delete/supersede touch
-- other columns. Retrieval code must therefore never query memories_fts
-- alone — every FTS join goes through this view
-- (JOIN memories_live m ON m.seq = f.rowid), or a deleted/superseded
-- memory can resurface in recall, which breaks the privacy promise of
-- BUILD_BRIEF §2/§10. seq is now a real column, so it is exposed by "*"
-- with no workaround needed.
CREATE VIEW memories_live AS
  SELECT * FROM memories
  WHERE deleted_at IS NULL AND valid_until IS NULL;
`;

const FTS_DDL = `
-- memories_fts and the future vec0 tables key off memories.seq, the
-- AUTOINCREMENT rowid, not the TEXT id. seq is stable and never reused
-- (unlike the implicit rowid a TEXT-only primary key would get), which is
-- what guarantees a purged memory's vector row can never be inherited by a
-- later, unrelated insert.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='seq',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.seq, new.text);
END;
`;

// No vec0 tables are created here. They are created lazily per (model_id,
// dim) by the vector module, because vec0 fixes the embedding dimension at
// DDL time and because the database must still open and work when the
// sqlite-vec extension is unavailable — that is the instant FTS-only mode
// of BUILD_BRIEF §2.
const AUX_TABLES_DDL = `
CREATE TABLE vector_spaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id   TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  table_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (model_id, dim)
);

CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  CHECK (enabled IN (0, 1))
);

-- audit_log intentionally has NO foreign key to memories: the access log
-- must survive a hard purge of the memory it refers to, or the dashboard's
-- audit trail would silently rewrite history (BUILD_BRIEF §5, §9).
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  action        TEXT NOT NULL,
  memory_id     TEXT,
  scope         TEXT,
  source_client TEXT,
  query         TEXT,
  result_count  INTEGER,
  details       TEXT,
  -- A refused call (e.g. a paused client) is logged under the action it
  -- attempted, so this column is what lets the dashboard and
  -- countAuditByClient tell a refusal apart from work the app actually did.
  refused       INTEGER NOT NULL DEFAULT 0,
  CHECK (refused IN (0, 1))
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC, id DESC);
CREATE INDEX idx_audit_client_ts ON audit_log(source_client, ts DESC, id DESC);
CREATE INDEX idx_audit_action_ts ON audit_log(action, ts DESC, id DESC);
CREATE INDEX idx_audit_memory ON audit_log(memory_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const migration001: Migration = {
  version: 1,
  name: "init",
  up(driver) {
    driver.exec(TABLES_DDL);
    driver.exec(FTS_DDL);
    driver.exec(AUX_TABLES_DDL);
  },
};

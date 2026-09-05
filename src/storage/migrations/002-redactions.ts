import type { Migration } from "./index.js";

// The first schema change since the repository went public (see the NOTE on
// migration001 in 001-init.ts). It is also the first migration ever applied
// as the SECOND entry in the runner's list against a real (non-synthetic)
// upgrade path: every prior exercise of runMigrations only ever had one
// migration to apply. `up` here therefore must not touch anything migration
// 001 already created — it only adds.
const DDL = `
-- redactions is the persisted "what's stored / what was blocked" record the
-- §9 privacy view renders (BUILD_BRIEF §9, §10): one row per secret the §10
-- redactor found, whether the write was allowed through with the secret
-- masked out (action = 'redacted') or refused outright (action = 'blocked',
-- in which case memory_id is null because no memory was ever created).
--
-- Deliberately NO foreign key to memories, for the same reason audit_log
-- has none (see the comment on that table in 001-init.ts): this record must
-- survive a hard purge of the memory it refers to, or the privacy view
-- would quietly rewrite its own history -- the exact opposite of what a
-- "what was blocked" log is for.
CREATE TABLE redactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  memory_id     TEXT,             -- null when the write was BLOCKED and no memory exists
  episode_id    TEXT,
  scope         TEXT,
  source_client TEXT,
  kind          TEXT NOT NULL,    -- the detector's SecretKind
  -- MASKED excerpt only, by contract -- this table is exactly what the
  -- dashboard renders, so writing the raw secret here would defeat the
  -- entire feature this table exists for. Never store an unmasked value.
  preview       TEXT NOT NULL,
  action        TEXT NOT NULL,    -- 'redacted' | 'blocked'
  CHECK (action IN ('redacted', 'blocked'))
);
CREATE INDEX idx_redactions_ts ON redactions(ts DESC, id DESC);
CREATE INDEX idx_redactions_memory ON redactions(memory_id);
`;

export const migration002: Migration = {
  version: 2,
  name: "redactions",
  up(driver) {
    driver.exec(DDL);
  },
};

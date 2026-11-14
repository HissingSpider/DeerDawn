'use strict';

// THE ADD-ON TABLES.
//
// Four new tables, all keyed by owner_key and (except workspace_addons) by the
// PERSON the row belongs to. Add-on data never goes into context_graph_nodes:
// two hundred clothing items in the graph would surface in recall, briefs, the
// portfolio and auto-archive, and would pass through the landing rule.
//
// Created like workspaceService.ensureSchema: lazily, memoised, and from
// autoMigrate before its transaction. The tables are NEW, so their indexes are
// built while they are empty and never as a plain CREATE INDEX on a hot table.
// A SECOND BOOT IS A NO-OP: the catalog is asked first and no DDL runs (and so
// no lock is taken) when every table already exists — see the header of
// config/autoMigrate.js for why "IF NOT EXISTS" alone is not that.

const db = require('../config/db');

const TABLES = ['workspace_addons', 'addon_records', 'addon_attachments', 'addon_upload_tokens'];

const DDL = [
  `CREATE TABLE IF NOT EXISTS workspace_addons (
    owner_key    TEXT NOT NULL,
    addon_id     TEXT NOT NULL,
    version      TEXT,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
    installed_by TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_key, addon_id)
  )`,
  // visibility allows the three project states so v2 needs no constraint swap;
  // v1 writes 'personal' only and reads nothing else.
  `CREATE TABLE IF NOT EXISTS addon_records (
    id          TEXT PRIMARY KEY,
    owner_key   TEXT NOT NULL,
    addon_id    TEXT NOT NULL,
    collection  TEXT NOT NULL,
    person_id   TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'personal' CHECK (visibility IN ('personal', 'private', 'shared')),
    project_id  TEXT,
    data        JSONB NOT NULL,
    -- Millisecond precision on purpose: list() pages by (timestamp, id) through
    -- a cursor that round-trips a JS Date, which has no microseconds.
    created_at  TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', NOW()),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', NOW())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_addon_records_scope
     ON addon_records (owner_key, addon_id, person_id, collection, created_at DESC, id DESC)`,
  'CREATE INDEX IF NOT EXISTS idx_addon_records_person ON addon_records (person_id)',
  `CREATE TABLE IF NOT EXISTS addon_attachments (
    id           TEXT PRIMARY KEY,
    owner_key    TEXT NOT NULL,
    person_id    TEXT NOT NULL,
    addon_id     TEXT NOT NULL,
    collection   TEXT NOT NULL,
    record_id    TEXT,
    sha256       TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        BIGINT NOT NULL,
    stored_bytes BIGINT NOT NULL DEFAULT 0,
    width        INTEGER,
    height       INTEGER,
    storage_key  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_addon_attachments_scope
     ON addon_attachments (owner_key, addon_id, person_id, record_id)`,
  'CREATE INDEX IF NOT EXISTS idx_addon_attachments_person ON addon_attachments (person_id)',
  `CREATE TABLE IF NOT EXISTS addon_upload_tokens (
    token_hash  TEXT PRIMARY KEY,
    owner_key   TEXT NOT NULL,
    person_id   TEXT NOT NULL,
    addon_id    TEXT NOT NULL,
    collection  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    uses        INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER NOT NULL DEFAULT 50,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_addon_upload_tokens_owner ON addon_upload_tokens (owner_key)',
  'CREATE INDEX IF NOT EXISTS idx_addon_upload_tokens_person ON addon_upload_tokens (person_id)',
];

let ready = null;

async function tablesPresent(query) {
  const r = await query(
    'SELECT count(*)::int AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass(t.name) IS NOT NULL',
    [TABLES],
    'org-system'
  );
  return r.rows[0]?.n === TABLES.length;
}

/** Create the add-on tables if any is missing. Memoised per process. */
function ensureAddonSchema({ query = db.query } = {}) {
  if (!ready) {
    ready = (async () => {
      if (await tablesPresent(query)) return;
      for (const statement of DDL) await query(statement, [], 'org-system');
    })().catch((err) => {
      ready = null; // a failed attempt is retried by the next caller
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureAddonSchema, ADDON_TABLES: TABLES };

const db = require('../config/db');
const { getPublisher } = require('../config/redis');
const { normalizeGraphNodeTitle } = require('./graphNodeTitle');
const encryption = require('../services/encryptionService');
const workspace = require('../services/workspaceService');
const { redactSecrets, secretSafeKey } = require('../utils/secretRedaction');

// NOTHING SECRET IS PERSISTED, WHICHEVER PATH WROTE IT.
//
// The redactor ran on SOME fields (a decision's summary, a command's `run`),
// field by field in the service's normalizers. Every field it was not wired
// into — a finding's summary, a decision's model-written headline, the task,
// the status, the goals, a graph node titled with a raw summary, the event log
// — stored a pasted live key verbatim and served it back on /active (which the
// SessionStart hook injects), /inject and /trail. A per-field list is the shape
// that keeps missing one, so the store applies it at the four writes every path
// ends in: the project context, the event log, graph nodes and evidence, and
// the global profile. Mask, don't drop: the redactor replaces only the secret
// span. Idempotent, so text already cleaned upstream is unchanged.
//
// And it must be a NO-OP ON CLEAN TEXT, because everything that compares a
// caller's words with the stored ones (a card looked up by its title, "is this
// the same task?" before clearing next_action) is otherwise comparing two
// different strings. The patterns are anchored so ordinary prose, kebab ids and
// paths pass through untouched (tests/unit/secret-redaction-corpus.test.js), and
// the service redacts an incoming patch or delta BEFORE it merges, so where a
// genuine secret is masked the comparison sees the masked form too.
//
// Recursion is bounded, and only plain objects and arrays are walked.
const STORAGE_REDACTION_MAX_DEPTH = 24;
function redactForStorage(value, depth = 0) {
  if (typeof value === 'string') return redactSecrets(value);
  if (!value || typeof value !== 'object' || depth > STORAGE_REDACTION_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactForStorage(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactForStorage(item, depth + 1);
  return out;
}
let schemaReadyPromise = null;

// A person's private notes (metadata.private_to, the founder's pre-team nodes)
// are erased BY THE MARK, across every workspace that holds one
// (dataErasureService erasePrivateNodesElsewhere, scan 34): the roster that
// used to name those workspaces is gone by the time the Clerk webhook erases.
// Partial, so it holds only marked rows; a generic plan for
// `metadata->>'private_to' = ANY($1)` uses it (checked with EXPLAIN).
//
// BUILT CONCURRENTLY, AND NOT ON THE WAY TO ANYTHING (scan 35 a/F4). It was a
// plain CREATE INDEX in ensureSchema: the first boot after the deploy took a
// SHARE lock on context_graph_nodes for a full-table scan — every graph write
// waited behind it — under the 25s statement timeout, through the 8s query
// breaker, and a timeout rejected ensureSchema for every store call until a
// retry won. Now: a catalog read on a dedicated connection (no lock on the
// table at all) when the index is there and valid, which is every boot but the
// first; otherwise CREATE INDEX CONCURRENTLY, which never blocks writes, with
// no statement timeout, in the background. A build that failed leaves an
// INVALID index under the name, which IF NOT EXISTS would then accept for
// ever, so an invalid one is dropped and rebuilt — unless another machine is
// building it right now (pg_stat_progress_create_index).
const PRIVATE_TO_INDEX = 'idx_context_graph_nodes_private_to';
let privateToIndexPromise = null;
async function ensurePrivateToIndex() {
  const client = await db.pool.connect();
  let broken = null;
  try {
    const state = (await client.query(
      `SELECT i.indisvalid AS valid,
              EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = i.indexrelid) AS building
         FROM pg_index i
        WHERE i.indexrelid = to_regclass($1)`,
      [PRIVATE_TO_INDEX]
    )).rows[0];
    if (state?.valid || state?.building) return 'present';
    await client.query('SET statement_timeout = 0');
    try {
      if (state) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${PRIVATE_TO_INDEX}`);
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${PRIVATE_TO_INDEX}
           ON context_graph_nodes ((metadata->>'private_to'))
           WHERE metadata->>'private_to' IS NOT NULL`
      );
    } finally {
      await client.query('RESET statement_timeout');
    }
    return 'built';
  } catch (err) {
    broken = err;
    throw err;
  } finally {
    // After a failure the connection may still carry statement_timeout 0:
    // it is closed, not returned to the pool.
    client.release(broken ? true : undefined);
  }
}
function ensurePrivateToIndexInBackground() {
  if (privateToIndexPromise) return privateToIndexPromise;
  privateToIndexPromise = ensurePrivateToIndex().catch((err) => {
    // Another machine building it at the same moment (42P07/23505) is fine;
    // anything else is retried on the next schema bootstrap.
    privateToIndexPromise = null;
    console.warn('[CONTEXT] private_to index build deferred:', err.message);
    return 'deferred';
  });
  return privateToIndexPromise;
}

function isConcurrentSchemaBootstrapError(err) {
  return err?.code === '23505' && String(err?.message || '').includes('pg_type_typname_nsp_index');
}

// AN INDEX THAT IS ALREADY THERE COSTS A CATALOG READ, NOT A TABLE LOCK.
//
// `CREATE INDEX IF NOT EXISTS` on an index that exists still takes its SHARE
// lock on the table before it looks (scan 36 a/F3). While another machine's
// CREATE INDEX CONCURRENTLY holds SHARE UPDATE EXCLUSIVE on context_graph_nodes
// (ensurePrivateToIndex, which can run for as long as the oldest open snapshot
// lasts), a booting machine's ensureSchema queued behind it until its statement
// timeout rejected the whole bootstrap, and every graph write queued behind the
// queued SHARE request. to_regclass takes no lock on the table, so an index
// that exists — every index, on every boot but the first — is skipped without
// ever joining that queue. Same semantics as IF NOT EXISTS: a name that is
// there is left alone.
async function createIndexIfMissing(sql, params = [], context = 'org-system') {
  const name = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/i.exec(sql)?.[1];
  if (name) {
    const present = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [name], context);
    if (present.rows[0]?.present) return present;
  }
  return db.query(sql, params, context);
}

// WHAT KIND OF TEXT AN EVIDENCE ROW'S EXCERPT IS. 'derived' — a line the
// product wrote (services/graphEvidenceLine.js) — on every row written since the
// write path stopped storing the conversation; NULL on every row written before.
// scripts/purge-raw-excerpts.js reads it to tell the two apart.
//
// Nullable, no default: adding it is a catalog change that rewrites no row and
// leaves every existing row NULL, which is exactly "written before". Asked of the
// catalog first, so a database that has it takes no lock on the table at all
// (the ALTER takes ACCESS EXCLUSIVE before it looks — see config/autoMigrate.js).
async function ensureEvidenceExcerptKindColumn() {
  const present = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'context_graph_evidence' AND column_name = 'excerpt_kind'`,
    [],
    'org-system'
  );
  if (present.rows.length) return;
  await db.query('ALTER TABLE context_graph_evidence ADD COLUMN IF NOT EXISTS excerpt_kind TEXT', [], 'org-system');
}

// ADD COLUMN, asked of the catalog first. `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS` takes ACCESS EXCLUSIVE before it looks, so on a busy table every boot
// queued behind (and in front of) live traffic just to learn the column was
// there. Same semantics: a column that exists is left alone.
async function addColumnIfMissing(table, column, definition) {
  const present = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
    'org-system'
  );
  if (present.rows.length) return;
  await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`, [], 'org-system');
}

// THE TRANSPORT BACKFILL: off the request path, in batches, idempotent.
//
// Sessions written before the transport column carry NULL. A hosted session id
// is `web-...` and the local server's is `agent-...`; a load whose tool ends in
// `_web` came through the hosted endpoint and every other load is the local
// server's own call. Anything else could have arrived on more than one path and
// stays NULL. Until this has run every reader derives the same answer (see
// GET /context/tools/status), so nothing waits for it.
//
// It used to be two unbatched UPDATEs inside ensureSchema, which the first
// request after every boot awaited (76 s on 3M rows). Now: a timer that starts
// well after boot (unref'd, so it never holds a process open), then keyset
// batches over the primary key, each its own statement and its own short lock,
// with a pause between them. Safe to run from several instances at once.
const TRANSPORT_BACKFILL_DEFAULT_DELAY_MS = 30_000;
// One instance at a time: several machines booting together would otherwise
// update the same rows from each side and deadlock. A session-level advisory
// lock on a dedicated connection; a machine that cannot take it skips quietly.
const TRANSPORT_BACKFILL_LOCK_KEY = 0x44443033; // 'DD03'
let transportBackfillScheduled = false;

function transportBackfillSettings(options = {}) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    batchSize: Math.max(1, Math.floor(num(options.batchSize ?? process.env.DEERDAWN_TRANSPORT_BACKFILL_BATCH, 5000))),
    pauseMs: num(options.pauseMs ?? process.env.DEERDAWN_TRANSPORT_BACKFILL_PAUSE_MS, 25),
  };
}

async function runTransportBackfill(options = {}) {
  await ensureSchema();
  const lock = await db.pool.connect();
  try {
    const got = await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [TRANSPORT_BACKFILL_LOCK_KEY]);
    if (!got.rows[0]?.locked) return { skipped: true };
    try {
      return await backfillTransportBatches(options);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [TRANSPORT_BACKFILL_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

async function backfillTransportBatches(options) {
  const startedAt = Date.now();
  const { batchSize, pauseMs } = transportBackfillSettings(options);
  const totals = { batches: 0, scanned: 0, updated: 0, sessions: 0, loads: 0 };
  const pause = () => (pauseMs ? new Promise((resolve) => setTimeout(resolve, pauseMs)) : Promise.resolve());

  let cursor = null;
  for (;;) {
    const after = cursor ? 'WHERE (owner_key, session_id) > ($2, $3)' : 'WHERE $2::text IS NULL AND $3::text IS NULL';
    const res = await db.query(
      `WITH batch AS (
         SELECT owner_key, session_id FROM context_sessions ${after}
          ORDER BY owner_key, session_id LIMIT $1
       ), upd AS (
         UPDATE context_sessions s
            SET transport = CASE WHEN s.session_id LIKE 'web-%' THEN 'hosted' ELSE 'local_stdio' END
           FROM batch b
          WHERE s.owner_key = b.owner_key AND s.session_id = b.session_id
            AND s.transport IS NULL
            AND (s.session_id LIKE 'web-%' OR s.session_id LIKE 'agent-%')
        RETURNING 1
       )
       SELECT (SELECT count(*) FROM batch)::int AS scanned,
              (SELECT count(*) FROM upd)::int AS updated,
              (SELECT owner_key FROM batch ORDER BY owner_key DESC, session_id DESC LIMIT 1) AS last_owner,
              (SELECT session_id FROM batch ORDER BY owner_key DESC, session_id DESC LIMIT 1) AS last_id`,
      [batchSize, cursor?.owner ?? null, cursor?.id ?? null],
      'org-system'
    );
    const row = res.rows[0] || {};
    totals.batches += 1;
    totals.scanned += row.scanned || 0;
    totals.updated += row.updated || 0;
    totals.sessions += row.updated || 0;
    if (!row.scanned || row.scanned < batchSize) break;
    cursor = { owner: row.last_owner, id: row.last_id };
    await pause();
  }

  let lastLoad = null;
  for (;;) {
    const after = lastLoad ? 'WHERE load_id > $2' : 'WHERE $2::text IS NULL';
    const res = await db.query(
      `WITH batch AS (
         SELECT load_id FROM context_session_loads ${after} ORDER BY load_id LIMIT $1
       ), upd AS (
         UPDATE context_session_loads l
            SET transport = CASE WHEN l.tool LIKE '%\\_web' THEN 'hosted' ELSE 'local_stdio' END
           FROM batch b
          WHERE l.load_id = b.load_id AND l.transport IS NULL AND l.tool IS NOT NULL
        RETURNING 1
       )
       SELECT (SELECT count(*) FROM batch)::int AS scanned,
              (SELECT count(*) FROM upd)::int AS updated,
              (SELECT load_id FROM batch ORDER BY load_id DESC LIMIT 1) AS last_id`,
      [batchSize, lastLoad],
      'org-system'
    );
    const row = res.rows[0] || {};
    totals.batches += 1;
    totals.scanned += row.scanned || 0;
    totals.updated += row.updated || 0;
    totals.loads += row.updated || 0;
    if (!row.scanned || row.scanned < batchSize) break;
    lastLoad = row.last_id;
    await pause();
  }
  // One line, so a finished backfill is visible in production logs.
  console.log(`[CONTEXT] transport backfill finished: context_sessions updated=${totals.sessions}, context_session_loads updated=${totals.loads} (${totals.batches} batches, ${Date.now() - startedAt} ms)`);
  return totals;
}

// Scheduled once per process, after the schema is ready and well after boot.
//
// NEVER IN A TEST PROCESS, and never when DEERDAWN_TRANSPORT_BACKFILL_DISABLE=1.
// A test process that stays up for 30 s would fire it in the middle of whatever
// the suite is timing (scan17's perf budgets), against rows it does not own.
// Tests that exercise the backfill call runTransportBackfill() themselves.
function scheduleTransportBackfill() {
  if (transportBackfillScheduled) return;
  if (process.env.NODE_ENV === 'test' || process.env.DEERDAWN_TRANSPORT_BACKFILL_DISABLE === '1') return;
  transportBackfillScheduled = true;
  const configured = Number(process.env.DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS);
  const delay = Number.isFinite(configured) && configured >= 0 ? configured : TRANSPORT_BACKFILL_DEFAULT_DELAY_MS;
  const timer = setTimeout(() => {
    runTransportBackfill().catch((err) => console.warn('[CONTEXT] transport backfill stopped:', err.message));
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_projects (
          project_id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          owner_user_id TEXT,
          visibility TEXT NOT NULL DEFAULT 'private',
          project_name TEXT NOT NULL,
          aliases TEXT[] DEFAULT '{}',
          linked_paths TEXT[] DEFAULT '{}',
          linked_conversations TEXT[] DEFAULT '{}',
          context JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      await db.query(
        `ALTER TABLE context_projects
         ADD COLUMN IF NOT EXISTS owner_user_id TEXT`,
        [],
        'org-system'
      );
      await db.query(
        `ALTER TABLE context_projects
         ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'`,
        [],
        'org-system'
      );
      // Workspace key (repo identity): groups projects that share a codebase into
      // one workspace so they're treated as sibling work-streams rather than N
      // peer projects competing on recency. Derived git-only client-side
      // (normalized git remote, else git-root); nullable + backfillable.
      await db.query(
        `ALTER TABLE context_projects
         ADD COLUMN IF NOT EXISTS workspace_key TEXT`,
        [],
        'org-system'
      );
      // Subprojects (workstream hierarchy): a subproject is a normal project row
      // that points at a parent. It reuses every per-project mechanism — its own
      // current_task, board, knowledge, and events — so no new storage shape is
      // needed. ON DELETE SET NULL orphans children back to top-level rather than
      // destroying their work. One level deep and same-owner are enforced in the
      // service, not the column. Nullable + backfillable.
      await db.query(
        `ALTER TABLE context_projects
         ADD COLUMN IF NOT EXISTS parent_project_id TEXT
           REFERENCES context_projects(project_id) ON DELETE SET NULL`,
        [],
        'org-system'
      );
      // Archive: soft-hide a dead project from the list and from active-project
      // resolution without deleting it (and its history). NULL = live. Kept
      // separate from `visibility` (private/shared), which it's orthogonal to.
      // A MONOTONIC VERSION, because a timestamp cannot separate two writes that
      // land in the same instant. The compare-and-swap previously guarded on
      // date_trunc('milliseconds', updated_at) — millisecond truncation was
      // needed because a JS ISO string cannot match a microsecond-precision
      // value round-tripped through Date, and the cost was that two writes
      // inside one millisecond both satisfied the guard. That is exactly the
      // collision the swap exists to catch, on a hot project with several agents
      // flushing at once. A counter has no precision to lose.
      await db.query(
        'ALTER TABLE context_projects ADD COLUMN IF NOT EXISTS context_version BIGINT NOT NULL DEFAULT 0',
        [],
        'org-system'
      );
      await db.query(
        'ALTER TABLE context_projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ',
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_project_shares (
          project_id TEXT PRIMARY KEY REFERENCES context_projects(project_id) ON DELETE CASCADE,
          org_id TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_project_share_sections (
          project_id TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
          section_key TEXT NOT NULL,
          can_view BOOLEAN NOT NULL DEFAULT TRUE,
          can_edit BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (project_id, section_key)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_project_members (
          project_id TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role_override TEXT NOT NULL,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (project_id, user_id)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_events (
          event_id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          event_kind TEXT NOT NULL,
          delta JSONB DEFAULT '{}',
          confidence FLOAT NOT NULL,
          contributing_user_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // Per-user attribution (team/shared-workspace moat): existing deployments
      // get the column added idempotently. Distinguishes WHO contributed even
      // though owner_key collapses everyone in an org to one workspace.
      await db.query(
        'ALTER TABLE context_events ADD COLUMN IF NOT EXISTS contributing_user_id TEXT',
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS injection_preferences (
          owner_key TEXT PRIMARY KEY,
          preferences JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // Active-subproject pointer: which subproject the user explicitly switched
      // to for a given codebase (keyed by workspace_key / git identity). This is
      // the durable "remember my last subproject" that replaces the recency
      // coin-flip when several subprojects share one workspace. Deliberately NO
      // FK on active_project_id — a deleted project just leaves a stale pointer
      // that resolveActiveProject ignores (candidate not found), which is safer
      // than a cascade during project deletion.
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_workspace_pointers (
          owner_key TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          active_project_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (owner_key, workspace_key)
        )`,
        [],
        'org-system'
      );
      // THE PIN IS PER PERSON.
      //
      // Keyed (owner_key, workspace_key), one row answered for the whole
      // workspace: a teammate switching subproject moved everybody who works in
      // that repo, silently, on their next session. user_id '' is the WORKSPACE
      // DEFAULT, which is what every row written before this column is — so an
      // existing pin keeps working for everyone until a person pins for
      // themselves. '' rather than NULL because it is part of the key, and NULLs
      // never conflict with each other.
      await db.query(
        'ALTER TABLE context_workspace_pointers ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT \'\'',
        [],
        'org-system'
      );
      // Widen the primary key once. Guarded on the key's own columns so a second
      // boot, or a second instance, finds nothing to do.
      await db.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (
             SELECT 1
               FROM information_schema.key_column_usage
              WHERE table_schema = current_schema()
                AND table_name = 'context_workspace_pointers'
                AND constraint_name = 'context_workspace_pointers_pkey'
                AND column_name = 'user_id'
           ) THEN
             ALTER TABLE context_workspace_pointers DROP CONSTRAINT IF EXISTS context_workspace_pointers_pkey;
             ALTER TABLE context_workspace_pointers
               ADD CONSTRAINT context_workspace_pointers_pkey PRIMARY KEY (owner_key, workspace_key, user_id);
           END IF;
         END $$`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_globals (
          owner_key TEXT PRIMARY KEY,
          global JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // THE "YOU" PROFILE IS A PERSON'S, NOT THE WORKSPACE'S.
      //
      // Keyed by owner_key alone, one row answered for everybody in the
      // workspace: the day a solo founder invited a colleague, the colleague's
      // brief opened with the founder's profile ("You: ... Goals: leave the
      // company by November"). person_id '' is the pre-column WORKSPACE row; it
      // belongs to the workspace's founder (see GLOBAL_FOUNDER_SQL), is claimed
      // for them below and on their first read, and is never shown to anybody
      // else. '' rather than NULL because it is part of the key.
      await db.query(
        'ALTER TABLE context_globals ADD COLUMN IF NOT EXISTS person_id TEXT NOT NULL DEFAULT \'\'',
        [],
        'org-system'
      );
      // WHEN THE PERSON LAST LOOKED AT THEIR OWN PROFILE. NULL on a row that has
      // data means they have not: extraction used to lift lines out of their
      // projects into it (journey round 5), and the dashboard You page asks them
      // once to check. Set by an explicit save or by dismissing that note, and
      // by nothing else, so it is a durable "already asked".
      await db.query(
        'ALTER TABLE context_globals ADD COLUMN IF NOT EXISTS profile_reviewed_at TIMESTAMPTZ',
        [],
        'org-system'
      );
      await db.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (
             SELECT 1
               FROM information_schema.key_column_usage
              WHERE table_schema = current_schema()
                AND table_name = 'context_globals'
                AND constraint_name = 'context_globals_pkey'
                AND column_name = 'person_id'
           ) THEN
             ALTER TABLE context_globals DROP CONSTRAINT IF EXISTS context_globals_pkey;
             ALTER TABLE context_globals
               ADD CONSTRAINT context_globals_pkey PRIMARY KEY (owner_key, person_id);
           END IF;
         END $$`,
        [],
        'org-system'
      );
      await claimLegacyGlobals().catch((err) => {
        console.warn('[CONTEXT] legacy global profile claim skipped:', err.message);
      });
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_sessions (
          owner_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          surface_type TEXT NOT NULL,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
          conversation_ref TEXT DEFAULT '',
          cwd TEXT DEFAULT '',
          host TEXT DEFAULT '',
          tab_id TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          routing_state TEXT NOT NULL DEFAULT 'global_only',
          match_confidence FLOAT NOT NULL DEFAULT 0,
          last_confirmed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (owner_key, session_id)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_graph_nodes (
          node_id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
          node_type TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT DEFAULT '',
          metadata JSONB NOT NULL DEFAULT '{}',
          confidence FLOAT NOT NULL DEFAULT 0.5,
          source_session_id TEXT DEFAULT '',
          source_tool TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (owner_key, node_type, canonical_key)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_graph_edges (
          edge_id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
          edge_type TEXT NOT NULL,
          from_node_id TEXT NOT NULL REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
          to_node_id TEXT NOT NULL REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
          summary TEXT DEFAULT '',
          metadata JSONB NOT NULL DEFAULT '{}',
          confidence FLOAT NOT NULL DEFAULT 0.5,
          source_session_id TEXT DEFAULT '',
          source_tool TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (owner_key, edge_type, from_node_id, to_node_id)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_graph_evidence (
          evidence_id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
          session_id TEXT NOT NULL,
          node_id TEXT REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
          edge_id TEXT REFERENCES context_graph_edges(edge_id) ON DELETE CASCADE,
          tool TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}',
          confidence FLOAT NOT NULL DEFAULT 0.5,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      await ensureEvidenceExcerptKindColumn();
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_graph_embeddings (
          owner_key TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (owner_key, target_kind, target_id, model)
        )`,
        [],
        'org-system'
      );
      // Cross-project affinity: how often two projects co-occur in a workspace's
      // context. Strengthened over time so "projects you work alongside" becomes
      // learned, persisted knowledge rather than a per-call recomputation. Pairs
      // are stored canonically (project_a < project_b) so each pair is one row.
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_project_affinity (
          owner_key TEXT NOT NULL,
          project_a TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
          project_b TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
          co_occurrence_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (owner_key, project_a, project_b)
        )`,
        [],
        'org-system'
      );
      const sessionConstraintResult = await db.query(
        `SELECT pg_get_constraintdef(con.oid) AS constraint_def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'context_sessions' AND con.contype = 'p'`,
        [],
        'org-system'
      );
      const constraintDef = sessionConstraintResult.rows[0]?.constraint_def || '';
      if (constraintDef.includes('(session_id)') && !constraintDef.includes('(owner_key, session_id)')) {
        await db.query('ALTER TABLE context_sessions RENAME TO context_sessions_legacy', [], 'org-system');
        await db.query(
          `CREATE TABLE context_sessions (
            owner_key TEXT NOT NULL,
            session_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            surface_type TEXT NOT NULL,
            project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
            conversation_ref TEXT DEFAULT '',
            cwd TEXT DEFAULT '',
            host TEXT DEFAULT '',
            tab_id TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            routing_state TEXT NOT NULL DEFAULT 'global_only',
            match_confidence FLOAT NOT NULL DEFAULT 0,
            last_confirmed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (owner_key, session_id)
          )`,
          [],
          'org-system'
        );
        await db.query(
          `INSERT INTO context_sessions
             (owner_key, session_id, tool, surface_type, project_id, conversation_ref, cwd, host, tab_id, status, created_at, updated_at, last_seen_at)
           SELECT DISTINCT ON (owner_key, session_id)
             owner_key, session_id, tool, surface_type, project_id, conversation_ref, cwd, host, tab_id, status, created_at, updated_at, last_seen_at
           FROM context_sessions_legacy
           ORDER BY owner_key, session_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
          [],
          'org-system'
        );
        await db.query('DROP TABLE context_sessions_legacy', [], 'org-system');
      }
      await db.query(
        `ALTER TABLE context_sessions
         ADD COLUMN IF NOT EXISTS routing_state TEXT NOT NULL DEFAULT 'global_only'`,
        [],
        'org-system'
      );
      // WHO is driving this session. Presence could previously only name an
      // opaque session id, so a collision warning read "another agent has written
      // here: sess_a1b2" — true, and useless. On a shared workspace the peer is a
      // colleague, and naming them is the entire difference between a warning you
      // can act on and one you ignore.
      await db.query(
        'ALTER TABLE context_sessions ADD COLUMN IF NOT EXISTS user_id TEXT',
        [],
        'org-system'
      );
      // HOW the session's tool connects (local_stdio, hosted_oauth, hosted_api_key,
      // rest_api), kept apart from `tool`, which says only WHICH tool. See
      // services/connectionIdentity.js. Older rows are filled in LATER, in the
      // background and in batches (runTransportBackfill), and read through the
      // derivation until then: ensureSchema runs on the request path and must
      // not write rows.
      await addColumnIfMissing('context_sessions', 'transport', 'TEXT');
      await db.query(
        `ALTER TABLE context_sessions
         ADD COLUMN IF NOT EXISTS match_confidence FLOAT NOT NULL DEFAULT 0`,
        [],
        'org-system'
      );
      await db.query(
        `ALTER TABLE context_sessions
         ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ`,
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_sessions_owner_last_seen ON context_sessions(owner_key, last_seen_at DESC)',
        [],
        'org-system'
      );
      await ensureTaskReviewsTable();
      await ensureBindingNoticesTable();
      await ensureAuthorNoticesTable();
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_nodes_owner_project ON context_graph_nodes(owner_key, project_id, last_seen_at DESC)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_edges_owner_project ON context_graph_edges(owner_key, project_id, last_seen_at DESC)',
        [],
        'org-system'
      );
      // OWNER-WIDE recency, with no project in the predicate. The three indexes
      // above lead (owner_key, project_id, <time>), so project_id sits BETWEEN
      // the equality column and the sort column — Postgres can use them to find
      // the owner's rows but cannot take the ordering from them, and falls back
      // to reading every one of that owner's rows and sorting.
      //
      // listRecentGraphFacts asks all three tables for the newest 40, and it runs
      // on every brief: getProjectGraph calls it, and getSessionGraph calls it
      // again, so one session-bound start_session pays six owner-wide sorts whose
      // cost scales with the account's total graph rather than the 40 rows asked
      // for. This is the same class as the index blindspot that has already
      // tripped the DB breaker three times — one column over.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_nodes_owner_seen ON context_graph_nodes(owner_key, last_seen_at DESC)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_edges_owner_seen ON context_graph_edges(owner_key, last_seen_at DESC)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_evidence_owner_created ON context_graph_evidence(owner_key, created_at DESC)',
        [],
        'org-system'
      );
      // Edge endpoints are FKs, which Postgres does not auto-index. Index both
      // so `WHERE owner_key=$1 AND (from_node_id=$2 OR to_node_id=$2)` lookups
      // (graph traversal) can BitmapOr two index scans instead of seq-scanning.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_edges_owner_from ON context_graph_edges(owner_key, from_node_id)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_edges_owner_to ON context_graph_edges(owner_key, to_node_id)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_evidence_owner_project ON context_graph_evidence(owner_key, project_id, created_at DESC)',
        [],
        'org-system'
      );
      // Covers the portfolio's cross-project read (listCrossProjectEntities),
      // which needs (node_id, project_id) for one owner and nothing else — an
      // index-only scan rather than a heap fetch per evidence row.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_evidence_owner_node ON context_graph_evidence(owner_key, node_id, project_id)',
        [],
        'org-system'
      );
      // The private_to index is built OFF this path, concurrently: see
      // ensurePrivateToIndex. Not awaited, and nothing here depends on it.
      ensurePrivateToIndexInBackground();
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_graph_embeddings_owner_kind ON context_graph_embeddings(owner_key, target_kind)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_projects_owner_user ON context_projects(owner_user_id)',
        [],
        'org-system'
      );
      // "Has this PERSON saved anything, in any workspace": the activation
      // follow-up asks it per recipient by contributing_user_id, which led no
      // index. Partial: rows written by the system carry no contributor.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_events_contributor ON context_events(contributing_user_id) WHERE contributing_user_id IS NOT NULL',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_project_shares_org ON context_project_shares(org_id, enabled)',
        [],
        'org-system'
      );
      // Hot read-path predicates: listProjects filters owner_key + orders by
      // updated_at DESC; getProject reads context_events by project_id ordered by
      // created_at. Without these, both seq-scan as projects/events accumulate.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_projects_owner_updated ON context_projects(owner_key, updated_at DESC)',
        [],
        'org-system'
      );
      // Subproject lookups: getSubprojects filters owner_key + parent_project_id.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_projects_owner_parent ON context_projects(owner_key, parent_project_id)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_events_project_created ON context_events(project_id, created_at)',
        [],
        'org-system'
      );
      // Shared skills (markdown know-how) distributed across connected tools.
      // project_id NULL = workspace-wide; UNIQUE(owner_key, slug) keeps one slug
      // per owner regardless of scope. Always written full to disk (custody
      // bypassed) — distinct from the off-disk context brief.
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_skills (
          skill_id    TEXT PRIMARY KEY,
          owner_key   TEXT NOT NULL,
          project_id  TEXT REFERENCES context_projects(project_id) ON DELETE CASCADE,
          slug        TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT DEFAULT '',
          markdown_content TEXT NOT NULL,
          visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
          enabled     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (owner_key, slug)
        )`,
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_workspace_skills_owner ON workspace_skills(owner_key, enabled)',
        [],
        'org-system'
      );
      // One row per real session start (start_session with mark_session) — the
      // durable record behind session_number, last_session_at, and the
      // since-last-session delta. Deliberately separate from context_sessions,
      // which models extraction/routing sessions with their own lifecycle.
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_session_loads (
          load_id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          project_id TEXT REFERENCES context_projects(project_id) ON DELETE CASCADE,
          user_id TEXT,
          tool TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // The same split as context_sessions.transport, filled in the same way.
      await addColumnIfMissing('context_session_loads', 'transport', 'TEXT');
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_session_loads_owner_project ON context_session_loads(owner_key, project_id, created_at DESC)',
        [],
        'org-system'
      );
      // Time-leading twin of the index above. Every read of this table until now
      // was owner-scoped, so `owner_key` leading was enough. The operator view
      // (/admin/today) asks the opposite question — "everyone, in this window" —
      // and filters on created_at with NO owner. On the owner-leading index that
      // is not an index scan at all: Postgres cannot seek on the second and
      // third columns, so it reads every row of an append-only, unbounded table.
      // That is the exact shape that has tripped the 8s DB circuit breaker three
      // times on context_graph_*; the leading column is the whole story.
      // Person-scoped twin of the owner+project index: recordSessionLoad reads a
      // person's OWN history on a project (plus unattributed rows), so user_id has
      // to sit before created_at or the filter is applied row by row on the heap.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_session_loads_owner_project_user ON context_session_loads(owner_key, project_id, user_id, created_at DESC)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_session_loads_created ON context_session_loads(created_at DESC)',
      );
      // Owner + time, with nothing in between. team_activated asks "how many
      // distinct people loaded a session in this workspace in the last 7 days"
      // on EVERY start_session, and neither index above can answer it with a
      // seek: the owner-leading one has project_id in the middle, so created_at
      // is a filter rather than a range, and the time-leading one has no owner.
      // Without this the hottest path in the product scans every row a workspace
      // has ever written — 2,886 in thirty days on the dogfood account alone.
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_session_loads_owner_time ON context_session_loads(owner_key, created_at DESC)',
        [],
        'org-system'
      );
      // Public share links for a brief (/s/[token]). Deliberately NOT the existing
      // context_project_shares, which is an org-internal ACL (who on your team may
      // read which sections); this is an unauthenticated, revocable URL handed to
      // someone with no account at all.
      //
      // revoked_at is a tombstone, never a DELETE: a revoked token must keep
      // resolving to "this link was turned off" rather than to a 404 that reads
      // like a broken product, and the row is the only record that the URL was
      // ever live.
      await db.query(
        `CREATE TABLE IF NOT EXISTS context_share_tokens (
          token       TEXT PRIMARY KEY,
          owner_key   TEXT NOT NULL,
          project_id  TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
          visibility  TEXT NOT NULL DEFAULT 'unlisted' CHECK (visibility IN ('unlisted','public')),
          created_by  TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          revoked_at  TIMESTAMPTZ,
          last_viewed_at TIMESTAMPTZ,
          view_count  INTEGER NOT NULL DEFAULT 0,
          ref_code    TEXT,
          conversion_count INTEGER NOT NULL DEFAULT 0
        )`,
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_share_tokens_owner ON context_share_tokens(owner_key, revoked_at)',
        [],
        'org-system'
      );
      await createIndexIfMissing(
        'CREATE INDEX IF NOT EXISTS idx_context_share_tokens_project ON context_share_tokens(project_id)',
        [],
        'org-system'
      );
      // Referral attribution, added 2026-08-29. Deliberately a SECOND, independent
      // random value rather than the share token itself or anything derived from
      // the owner.
      //
      // Not the token: the token IS the authorisation to read the brief, and the
      // ref code travels into a query string, a visitor's localStorage, Clerk
      // unsafeMetadata and PostHog event properties. Reusing the token would put
      // read access to a private brief into the analytics pipeline.
      //
      // Not derived from the owner: one code per SHARE, not per account, so an
      // observer cannot correlate two links posted in different places back to
      // one person.
      // Authorship on a shared skill. Written here as well as in schema.sql and
      // autoMigrate.js because the three migration paths are reached by
      // different environments, and a skill write that silently dropped its
      // author would leave the authority check reading NULL — i.e. "anyone".
      await db.query(
        'ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS created_by TEXT',
        [],
        'org-system'
      // 42P01 = the table itself does not exist yet on this database; autoMigrate
      // creates it WITH the column, so there is nothing to add and nothing wrong.
      ).catch((err) => { if (err?.code !== '42P01') throw err; });
      await db.query(
        'ALTER TABLE context_share_tokens ADD COLUMN IF NOT EXISTS ref_code TEXT',
        [],
        'org-system'
      );
      await db.query(
        'ALTER TABLE context_share_tokens ADD COLUMN IF NOT EXISTS conversion_count INTEGER NOT NULL DEFAULT 0',
        [],
        'org-system'
      );
      // Backfill links minted before ref codes existed, so an old link that is
      // still being passed around is not permanently unattributable. Randomised
      // per row (md5 over random() plus the primary key) to match the property
      // that matters — a code must not be derivable from anything else about the
      // share — rather than the exact encoding a new mint uses.
      await db.query(
        `UPDATE context_share_tokens
            SET ref_code = 's_' || substr(md5(random()::text || token), 1, 16)
          WHERE ref_code IS NULL`,
        [],
        'org-system'
      );
      // ref_code LEADS this index because ref_code is exactly what the conversion
      // lookup filters on. A composite that led with owner_key would leave the
      // webhook's per-signup resolve doing a full scan of every owner's rows —
      // the repeat failure recorded against the context_graph_* joins.
      await createIndexIfMissing(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_context_share_tokens_ref_code ON context_share_tokens(ref_code)',
        [],
        'org-system'
      );
      scheduleTransportBackfill();
    })().catch(async (err) => {
      if (isConcurrentSchemaBootstrapError(err)) {
        schemaReadyPromise = null;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return ensureSchema();
      }
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

function publishContextEvent(channel, payload) {
  getPublisher()
    .publish(channel, JSON.stringify(payload))
    .catch((err) => {
      console.warn(`[REDIS] Failed to publish to ${channel}: ${err.message}`);
    });
}

async function rowToProject(row, eventRows) {
  let context = row.context;
  if (context?._enc) {
    try {
      context = await encryption.decryptContextObject(row.owner_key, context);
    } catch (err) {
      // DS-06: fail closed — never return the raw ciphertext object. Surface an empty,
      // clearly-marked context instead of leaking the encrypted blob to the caller.
      console.warn(`[ENCRYPTION] Failed to decrypt context for ${row.project_id}: ${err.message}`);
      context = { _decrypt_error: true };
    }
  }
  return {
    project_id: row.project_id,
    owner_key: row.owner_key,
    owner_user_id: row.owner_user_id || null,
    visibility: row.visibility || 'private',
    // The value a caller passes back as expectedVersion to swap safely.
    context_version: Number(row.context_version || 0),
    project_name: row.project_name,
    aliases: row.aliases || [],
    workspace_key: row.workspace_key || null,
    parent_project_id: row.parent_project_id || null,
    archived_at: row.archived_at instanceof Date ? row.archived_at.toISOString() : (row.archived_at || null),
    linked_paths: row.linked_paths || [],
    linked_conversations: row.linked_conversations || [],
    context,
    events: (eventRows || []).map((e) => ({
      event_id: e.event_id,
      project_id: e.project_id,
      source_type: e.source_type,
      source_id: e.source_id,
      event_kind: e.event_kind,
      delta: e.delta,
      confidence: parseFloat(e.confidence),
      created_at: e.created_at instanceof Date ? e.created_at.toISOString() : e.created_at,
    })),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function getProject(ownerKey, projectId) {
  await ensureSchema();
  const projectResult = await db.query(
    'SELECT * FROM context_projects WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey],
    'org-system'
  );
  if (!projectResult.rows.length) return null;

  const eventsResult = await db.query(
    'SELECT * FROM context_events WHERE project_id = $1 ORDER BY created_at ASC',
    [projectId],
    'org-system'
  );

  return await rowToProject(projectResult.rows[0], eventsResult.rows);
}

async function getProjectContextOnly(ownerKey, projectId) {
  await ensureSchema();
  const projectResult = await db.query(
    'SELECT * FROM context_projects WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey],
    'org-system'
  );
  if (!projectResult.rows.length) return null;
  return await rowToProject(projectResult.rows[0], []);
}

// Lightweight read for the optimistic-concurrency check on the write path: just
// updated_at, with no context_events read and no decrypt (unlike getProject).
async function getProjectUpdatedAt(ownerKey, projectId) {
  await ensureSchema();
  const result = await db.query(
    'SELECT updated_at FROM context_projects WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey],
    'org-system'
  );
  if (!result.rows.length) return null;
  const updatedAt = result.rows[0].updated_at;
  return updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
}

// Visibility filter for every project LISTING.
//
// The access check in contextSyncService decides whether a named project may be
// opened; this decides whether it may be enumerated, and the two are separate
// leaks. listProjects selected on owner_key alone, so even with the access check
// fixed, every project list, project map, workspace overview and project tree
// still recited teammates' private project NAMES back to them — and a project
// name is frequently the client's name.
//
// Applied in the store rather than at the callers on purpose: the listing is
// reached from REST, four MCP tools, the tree endpoint and the workspace
// overview, and a filter that has to be remembered at six call sites is one that
// will be missing at the seventh.
//
// An empty identity list means an unattributed caller (system actor, internal
// job) and filters nothing — those paths are already unrestricted by design.
//
// owner_user_id IS NULL passes deliberately: it marks a project created before
// per-user attribution existed, which belongs to the workspace rather than to
// anyone in particular. That ambiguity is resolved once and for all by
// workspaceService.backfillProjectOwnership at the moment a workspace gains its
// second member, so NULL can never mean "someone else's" by the time there is
// a someone else.
function visibilityClause(identities, params, { isWorkspaceOwner = false, system = false } = {}) {
  // FAILS CLOSED. An absent identity list used to mean "no filter", which made
  // every caller that forgot to pass one leak the whole workspace — and four
  // did: portfolioService, crossProjectService, extractionService and
  // shareService each read this list and surface project NAMES (and, via
  // portfolio and cross-project, DECISIONS) straight to the caller.
  //
  // That is exactly what the comment above warned about: a filter remembered at
  // six call sites will be missing at the seventh. So an unattributed call is
  // now an error unless it says `system: true` out loud.
  if (system) return '';
  const ids = (identities || []).filter(Boolean);
  if (!ids.length) {
    throw new Error(
      'visibilityClause: no actor identities and system:true not set — refusing to list a workspace unfiltered'
    );
  }
  params.push(ids);
  const identityParam = params.length;
  // 'personal' is absent from both lists on purpose: it is reachable only via
  // owner_user_id, so not even a workspace owner enumerates somebody else's
  // personal work. 'private' is org-owned and an owner may list it.
  const states = isWorkspaceOwner ? ['shared', 'private'] : ['shared'];
  params.push(states);
  return ` AND (visibility = ANY($${params.length}) OR owner_user_id IS NULL OR owner_user_id = ANY($${identityParam}))`;
}

async function listProjects(ownerKey, { includeArchived = false, actorIdentities = null, isWorkspaceOwner = false, system = false } = {}) {
  await ensureSchema();
  const params = [ownerKey];
  const archived = includeArchived ? '' : ' AND archived_at IS NULL';
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  const result = await db.query(
    `SELECT * FROM context_projects WHERE owner_key = $1${archived}${visible} ORDER BY updated_at DESC`,
    params,
    'org-system'
  );
  return await Promise.all(result.rows.map((row) => rowToProject(row, [])));
}

// Children of a parent project, most-recently-updated first. Events are omitted
// (like listProjects) — callers wanting a full brief re-read via getProject.
async function getSubprojects(ownerKey, parentProjectId, { includeArchived = false, actorIdentities = null, isWorkspaceOwner = false, system = false } = {}) {
  await ensureSchema();
  const params = [ownerKey, parentProjectId];
  const archived = includeArchived ? '' : ' AND archived_at IS NULL';
  // A private child under a shared parent is the easy one to miss: the parent is
  // visible, so without this the tree would name the child.
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  const result = await db.query(
    `SELECT * FROM context_projects WHERE owner_key = $1 AND parent_project_id = $2${archived}${visible} ORDER BY updated_at DESC`,
    params,
    'org-system'
  );
  return await Promise.all(result.rows.map((row) => rowToProject(row, [])));
}

// Soft-archive / restore: set or clear archived_at. Owner-scoped. Returns true
// when a row was actually updated. Deliberately a targeted UPDATE (not a full
// saveProject round-trip) so it skips the context re-encrypt.
//
// It ADVANCES context_version, as every write through saveProject does. It did
// not, so a dashboard tab opened before a project was archived (and restored)
// still held a "current" version, and its next guarded edit was saved as if
// nothing had happened (journey r4). An unguarded write is unaffected: the
// version only matters to a caller that sends the one it read.
async function setProjectArchived(ownerKey, projectId, archivedAt) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE context_projects SET archived_at = $3, updated_at = NOW(), context_version = context_version + 1
      WHERE project_id = $1 AND owner_key = $2`,
    [projectId, ownerKey, archivedAt],
    'org-system'
  );
  return result.rowCount > 0;
}

// Auto-archive candidates: live projects untouched since `cutoffIso`, across
// every owner (this is the nightly system job, not an owner-scoped read). No
// context column and no decrypt — the job only needs identity + owner.
//
// The NOT EXISTS clause mirrors the manual archiveProject guard: never hide an
// umbrella that still has live children out from under active work. A parent
// whose children are ALL stale is skipped this run, its children archive, and
// the parent becomes eligible on the next run — the sweep converges downward
// through the (one-level-deep) hierarchy instead of collapsing it at once.
//
// "UNTOUCHED" HAS TO INCLUDE BEING READ.
//
// This used to ask one question: has `updated_at` moved? That column is stamped
// by WRITES. But the thing this product does most is deliver a brief, which is a
// read. A finished, stable project that somebody opens every single morning —
// the reference project, the client that is in maintenance, the one whose brief
// is good enough that nothing needs adding — has no writes, so at day 30 it was
// archived out from under the person actively using it. They were then told it
// was "archived after 30 days without activity" about a project they had opened
// yesterday.
//
// Two read signals, both already recorded and both indexed on their leading
// column (see the graph-query index notes: a probe on a column that leads no
// index scans every owner's rows):
//   - context_sessions.last_seen_at: a session bound to the project is, or
//     recently was, live. idx_context_sessions_owner_last_seen leads on
//     owner_key, which is why owner_key is in the probe and not just project_id.
//   - product_events `context_delivered` naming the project: a brief was
//     actually handed to a tool. idx_product_events_org_name_created leads on
//     (org_id, event_name). Product events key to the WORKSPACE, so org_id is
//     the owner_key. A workspace whose owner_key is not an org id simply matches
//     nothing here and falls back to the other two signals.
//
// `visibility` is returned so the job can decide what it may say about the
// project to people other than its author.
async function listProjectsInactiveSince(cutoffIso, limit = 500) {
  await ensureSchema();
  const result = await db.query(
    `SELECT p.project_id, p.owner_key, p.owner_user_id, p.project_name, p.updated_at, p.visibility
       FROM context_projects p
      WHERE p.archived_at IS NULL
        AND p.updated_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM context_projects c
           WHERE c.parent_project_id = p.project_id
             AND c.owner_key = p.owner_key
             AND c.archived_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM context_sessions s
           WHERE s.owner_key = p.owner_key
             AND s.last_seen_at >= $1
             AND s.project_id = p.project_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM product_events e
           WHERE e.org_id = p.owner_key
             AND e.event_name = 'context_delivered'
             AND e.created_at >= $1
             AND e.metadata->>'project_id' = p.project_id
        )
      ORDER BY p.updated_at ASC
      LIMIT $2`,
    [cutoffIso, limit],
    'org-system'
  );
  return result.rows.map((row) => ({
    project_id: row.project_id,
    owner_key: row.owner_key,
    owner_user_id: row.owner_user_id || null,
    project_name: row.project_name,
    visibility: row.visibility || 'private',
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

// Archived projects, most-recently-archived first. Identity-only, no decrypt.
// This is the ONLY read that deliberately looks past `archived_at IS NULL`:
// start_session uses it so a user whose projects all aged out is told they
// still exist and can be restored, instead of being handed a bare "no context
// yet" and concluding DeerDawn forgot everything.
// `aliases` is selected because this is no longer only a display feed: the MCP
// name->id resolver reads this list to turn a project NAME into an id, and a
// project reachable only by an alias could not otherwise be restored by one.
// THE SEVENTH CALL SITE visibilityClause WAS WRITTEN FOR.
//
// listProjects and getSubprojects gained identity filtering; this one did not,
// so it went on selecting every archived row in the workspace. It feeds the
// start_session notice, which recites project NAMES back to the reader — so a
// viewer was told the name of a teammate's archived personal project, and handed
// the project_id that the unguarded archive/reparent paths accepted.
async function listArchivedProjects(ownerKey, limit = 10, { actorIdentities = null, isWorkspaceOwner = false, system = false } = {}) {
  await ensureSchema();
  const params = [ownerKey];
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  params.push(limit);
  // project_id breaks ties: the nightly job archives a whole account in one run,
  // and a listing that reorders itself between two calls reads as two answers.
  const result = await db.query(
    `SELECT project_id, project_name, aliases, archived_at, updated_at, owner_key, owner_user_id, visibility, parent_project_id
       FROM context_projects
      WHERE owner_key = $1 AND archived_at IS NOT NULL${visible}
      ORDER BY archived_at DESC, project_id
      LIMIT $${params.length}`,
    params,
    'org-system'
  );
  // The visibility columns are for the service's share-policy check (the same
  // one the live listing applies); listArchivedProjectSummaries drops them.
  return result.rows.map((row) => ({
    project_id: row.project_id,
    project_name: row.project_name,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    archived_at: row.archived_at instanceof Date ? row.archived_at.toISOString() : row.archived_at,
    owner_key: row.owner_key,
    owner_user_id: row.owner_user_id || null,
    visibility: row.visibility || 'private',
    parent_project_id: row.parent_project_id || null,
  }));
}

// Projected identity-only read (project_id, project_name, aliases) with no
// context column and no decrypt — for name/alias matching without paying to
// fetch + decrypt every project's context.
//
// VISIBILITY-FILTERED, like every other enumeration here: a name lookup that can reach a colleague's
// personal project both RESOLVES to it (a write lands somewhere invisible) and
// ECHOES it — createProject's duplicate-name refusal and the MCP resolver's
// ambiguity message each print the colliding project's name and id, and a project
// name is frequently a client's name.
//
// Archived rows are still included, deliberately: findProjectCandidatesByName can
// only prove a match is unique if nothing that could tie with it was out of view.
async function listProjectIdentifiers(
  ownerKey,
  { actorIdentities = null, isWorkspaceOwner = false, system = false } = {}
) {
  await ensureSchema();
  const params = [ownerKey];
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  const result = await db.query(
    `SELECT project_id, project_name, aliases FROM context_projects WHERE owner_key = $1${visible} ORDER BY updated_at DESC`,
    params,
    'org-system'
  );
  return result.rows.map((row) => ({
    project_id: row.project_id,
    project_name: row.project_name,
    aliases: row.aliases || [],
  }));
}

// Just the ids of the projects this actor may see — the same visibilityClause
// listProjects uses, with no context column and no decrypt. Used to decide which
// GRAPH nodes a teammate may see, so it must not be the heavier read.
async function listVisibleProjectIds(ownerKey, { actorIdentities = null, isWorkspaceOwner = false, system = false } = {}) {
  await ensureSchema();
  const params = [ownerKey];
  // Archived projects included: archiving hides a project from the brief, it
  // does not make what was learned there somebody else's to read.
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  const result = await db.query(
    `SELECT project_id FROM context_projects WHERE owner_key = $1${visible}`,
    params,
    'org-system'
  );
  return result.rows.map((row) => row.project_id);
}

// Could anything in this workspace be somebody else's? The question the
// visibility filters actually need answered before they may skip themselves.
//
// It used to be "does the workspace have more than one ACTIVE member", and that
// is a statement about today's roster, not about the data. A two-person team
// that shrinks back to one still holds the departed member's personal projects,
// their graph nodes and their audit history — and the remaining owner read all
// of it the moment the count hit one, while simultaneously losing the org-owned
// private work the owner role exists to keep reachable.
//
// So: true when the workspace has EVER held two people (membership rows survive
// removal; the ownership-backfill marker survives erasure, which hard-deletes
// them; legacy workspaces predating the roster are counted by users.org_id), or
// when any project in it is attributed to someone outside these identities —
// the per-project fact itself, which catches every path the others miss.
//
// One round trip, every branch owner-key-indexed, so a genuinely solo account —
// nearly every account — pays what it paid for the active-member count. Fails
// CLOSED: an error answers true, which costs a filter, never a leak.
async function workspaceMayHoldOthersWork(ownerKey, identities = []) {
  if (!ownerKey) return true;
  await ensureSchema();
  const ids = (identities || []).filter(Boolean);
  const result = await db.query(
    `SELECT (
       (SELECT COUNT(*) FROM workspace_members WHERE owner_key = $1) > 1
       OR EXISTS (SELECT 1 FROM workspace_ownership_backfills WHERE owner_key = $1)
       OR (SELECT COUNT(*) FROM users WHERE org_id = $1) > 1
       OR EXISTS (
         SELECT 1 FROM context_projects
          WHERE owner_key = $1 AND owner_user_id IS NOT NULL AND NOT (owner_user_id = ANY($2::text[]))
       )
     ) AS held`,
    [ownerKey, ids],
    'org-system'
  ).catch((err) => {
    console.warn(`[CONTEXT] workspaceMayHoldOthersWork failed, filtering: ${err.message}`);
    return null;
  });
  if (!result) return true;
  return result.rows[0]?.held === true;
}

// Every project each of these nodes has been SEEN in: its home project plus the
// projects on its evidence. A node keeps the first project it was seen in
// (upsertGraphNode's COALESCE), so the node row alone answers the question wrong.
//
// One owner-scoped pass, joined once — never a per-node lateral on
// context_graph_evidence, which is indexed (owner_key, project_id, created_at)
// and has no index on node_id: that shape measured 14,219ms against 177ms here,
// past the 8s breaker, and got worse the more the account used the product.
//
// A SIGHTING IS NOT A READ GRANT. Evidence stamped metadata.kind = 'sighting'
// (upsertWorkspaceEntities' recordSighting) records that a caller re-saved a
// node while working in another project: a usage record the portfolio counts
// (listCrossProjectEntities), not a fact derived from that project. Every caller
// here decides VISIBILITY from the answer, and a sighting counted as a read grant
// made one re-save a permanent one: the node stayed readable to whoever recorded
// it after its author took the home project personal (scan 32). So sightings are
// left out unless `includeSightings` asks for them (the de-duplication check
// before recording one).
//
// THE STORED HOME TRAVELS WITH THE ANSWER (`.homes`: node_id -> its project_id
// or null), because a node with no project is judged differently — evidence
// never narrows it (contextSyncService nodeVisibleIn, scan 33) — and the node
// objects a caller filters are not always whole rows: the portfolio's listings
// selected no project_id, so every homed node read as workspace-level and a
// colleague's personal-project entity was listed to the team. The filter asks
// the database, not the object it was handed.
async function listGraphNodeProjectIds(ownerKey, nodeIds = [], { includeSightings = false } = {}) {
  const ids = [...new Set((nodeIds || []).filter(Boolean))];
  const seen = new Map();
  seen.homes = new Map();
  if (!ids.length) return seen;
  await ensureSchema();
  const result = await db.query(
    `WITH homes AS (
            SELECT n.node_id, n.project_id
              FROM context_graph_nodes n
             WHERE n.owner_key = $1 AND n.node_id = ANY($2)
          ),
          sightings AS (
            SELECT h.node_id, h.project_id AS pid
              FROM homes h
             WHERE h.project_id IS NOT NULL
             UNION
            SELECT e.node_id, e.project_id
              FROM context_graph_evidence e
             WHERE e.owner_key = $1 AND e.project_id IS NOT NULL AND e.node_id = ANY($2)
               AND ($3::boolean OR COALESCE(e.metadata->>'kind', '') <> 'sighting')
          )
     SELECT h.node_id, h.project_id AS home,
            COALESCE(ARRAY_AGG(DISTINCT s.pid) FILTER (WHERE s.pid IS NOT NULL), '{}') AS project_ids
       FROM homes h
       LEFT JOIN sightings s ON s.node_id = h.node_id
      GROUP BY h.node_id, h.project_id`,
    [ownerKey, ids, includeSightings === true],
    'org-system'
  );
  for (const row of result.rows) {
    seen.homes.set(row.node_id, row.home || null);
    if ((row.project_ids || []).length) seen.set(row.node_id, row.project_ids);
  }
  return seen;
}

// Who reads each of these projects, as far as the graph landing rule needs to
// know (contextSyncService graphRebuildLanding: is this the writer's own
// personal project): its visibility and its author. No context, no decrypt.
async function listProjectReaders(ownerKey, projectIds = []) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!ownerKey || !ids.length) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT project_id, visibility, owner_user_id
       FROM context_projects
      WHERE owner_key = $1 AND project_id = ANY($2)`,
    [ownerKey, ids],
    'org-system'
  );
  return result.rows.map((row) => ({
    project_id: row.project_id,
    visibility: row.visibility || 'private',
    owner_user_id: row.owner_user_id || null,
  }));
}

// The share policy of every SHARED project in this list, in one round trip:
// what the graph filter needs to apply the per-section policy to nodes without a
// getProjectShare (three queries) per project. Only `shared` rows come back —
// personal and private projects are never read through a section policy.
// Returns the { share, sections } shape getProjectShare does, per project, plus
// the row's own visibility and author.
async function listProjectShareScopes(ownerKey, projectIds = []) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!ownerKey || !ids.length) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT p.project_id, p.owner_key, p.visibility, p.owner_user_id,
            s.project_id AS share_project_id, s.enabled AS share_enabled,
            COALESCE(
              json_agg(json_build_object('section_key', ss.section_key, 'can_view', ss.can_view, 'can_edit', ss.can_edit))
                FILTER (WHERE ss.section_key IS NOT NULL),
              '[]'::json
            ) AS sections
       FROM context_projects p
       LEFT JOIN context_project_shares s ON s.project_id = p.project_id
       LEFT JOIN context_project_share_sections ss ON ss.project_id = p.project_id
      WHERE p.owner_key = $1 AND p.project_id = ANY($2) AND p.visibility = 'shared'
      GROUP BY p.project_id, p.owner_key, p.visibility, p.owner_user_id, s.project_id, s.enabled`,
    [ownerKey, ids],
    'org-system'
  );
  return result.rows.map((row) => ({
    project: {
      project_id: row.project_id,
      owner_key: row.owner_key,
      visibility: row.visibility,
      owner_user_id: row.owner_user_id,
    },
    share: row.share_project_id ? { project_id: row.share_project_id, enabled: row.share_enabled } : null,
    sections: Array.isArray(row.sections) ? row.sections : [],
  }));
}

async function listProjectCandidates(
  ownerKey,
  { actorIdentities = null, isWorkspaceOwner = false, system = false, cwd = null, workspaceKey = null } = {}
) {
  await ensureSchema();
  // Wave 6 — bound the hot-path scan. Uses idx_context_projects_owner_updated
  // (owner_key, updated_at DESC) so the LIMIT is index-friendly.
  //
  // VISIBILITY-FILTERED, like listProjects and listVisibleProjectIds. This is the
  // candidate set active-project resolution ranks, so an unfiltered read here put
  // a colleague's personal project one recency tiebreak away from being the
  // project somebody else's writes landed in. Same clause, same failure mode as
  // the listing leak: a filter remembered at six call sites is missing at the
  // seventh.
  //
  // THE CLAUSE BEING INSIDE THE SQL IS NECESSARY, NOT SUFFICIENT. It keeps rows
  // the actor may not see from eating the LIMIT, but on a team everything
  // `shared` is a row they MAY see, and 200 newer shared rows are still 200 rows
  // that are not theirs. The person whose own project was older than that had it
  // fall out of the candidate set entirely: no path match from inside its own
  // directory, no tier-5 "my most recent project", and so a fall-through to
  // shared_fallback — their next write routed into a colleague's project.
  //
  // So the recency window is one of three bounded reads, unioned:
  //   - the 200 most recent rows this actor may see (unchanged);
  //   - this PERSON's own 200 most recent, whatever else is newer;
  //   - rows carrying the caller's location signal (same workspace_key, or a
  //     linked path that prefixes the cwd), because a location match is the
  //     strongest routing signal there is and recency must not be able to hide
  //     it. The prefix test here is a coarse prefilter; matchKindForCwd still
  //     does the boundary-safe comparison.
  // Each arm repeats the visibility clause, so the union can only ever contain
  // rows the first arm was allowed to return. Ordered updated_at DESC overall,
  // which callers rely on.
  //
  // owner_user_id is selected because the caller has to answer a second question
  // the visibility clause does not — "is this project THIS person's" — when there
  // is no location signal to rank by.
  const params = [ownerKey];
  const visible = visibilityClause(actorIdentities, params, { isWorkspaceOwner, system });
  const columns = 'project_id, project_name, owner_user_id, visibility, linked_paths, workspace_key, parent_project_id, created_at, updated_at';
  const base = `SELECT ${columns} FROM context_projects WHERE owner_key = $1 AND archived_at IS NULL${visible}`;
  const arms = [`(${base} ORDER BY updated_at DESC LIMIT 200)`];

  const ids = system ? [] : (actorIdentities || []).filter(Boolean);
  if (ids.length) {
    params.push(ids);
    arms.push(`(${base} AND owner_user_id = ANY($${params.length}) ORDER BY updated_at DESC LIMIT 200)`);
  }
  const located = [];
  if (workspaceKey) {
    params.push(String(workspaceKey));
    located.push(`workspace_key = $${params.length}`);
  }
  const normCwd = String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (normCwd) {
    params.push(normCwd);
    located.push(`EXISTS (
      SELECT 1 FROM unnest(linked_paths) AS lp
       WHERE lp <> '' AND left($${params.length}, length(rtrim(replace(lower(lp), '\\', '/'), '/'))) = rtrim(replace(lower(lp), '\\', '/'), '/')
    )`);
  }
  if (located.length) {
    arms.push(`(${base} AND (${located.join(' OR ')}) ORDER BY updated_at DESC LIMIT 200)`);
  }

  const result = await db.query(
    arms.length === 1
      ? arms[0].slice(1, -1)
      : `SELECT ${columns} FROM (${arms.join(' UNION ')}) AS candidates ORDER BY updated_at DESC`,
    params,
    'org-system'
  );
  return result.rows.map((row) => ({
    project_id: row.project_id,
    project_name: row.project_name,
    owner_user_id: row.owner_user_id || null,
    visibility: row.visibility || null,
    linked_paths: row.linked_paths || [],
    workspace_key: row.workspace_key || null,
    parent_project_id: row.parent_project_id || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

// Every OTHER live project's claim on the filesystem: which directories are
// already somebody's. Deliberately NOT visibility-filtered — a colleague's
// personal project still owns its directory, and the only thing the caller does
// with a claim it cannot see is decline to link over it, which reveals nothing.
// Archived rows are excluded: a retired project must not hold a directory
// hostage against whatever replaces it.
async function listLinkedPathClaims(ownerKey, excludeProjectId) {
  await ensureSchema();
  const result = await db.query(
    `SELECT project_id, linked_paths, parent_project_id, workspace_key
       FROM context_projects
      WHERE owner_key = $1
        AND project_id <> $2
        AND archived_at IS NULL
        AND cardinality(linked_paths) > 0`,
    [ownerKey, excludeProjectId],
    'org-system'
  );
  return result.rows.map((row) => ({
    project_id: row.project_id,
    linked_paths: row.linked_paths || [],
    parent_project_id: row.parent_project_id || null,
    workspace_key: row.workspace_key || null,
  }));
}

/**
 * The project THIS person's own sessions were last bound to.
 *
 * The session binding is the only durable record of "this person has actually
 * worked here" that survives across tool surfaces: the hosted connector derives a
 * stable per-person session id (hostedSessionIdentity) and the local server keeps
 * one per process, and applyExtraction writes project_id onto that row. Scoping by
 * user_id is what makes it an answer about a PERSON rather than about a workspace.
 *
 * Closed sessions are excluded — a session the user ended is not where their next
 * write belongs. Served by idx_context_sessions_owner_last_seen; the user_id and
 * project_id predicates are filters after the seek, and an owner has a handful of
 * sessions.
 */
async function getLatestSessionProject(ownerKey, identities) {
  const binding = await getLatestSessionBinding(ownerKey, identities);
  return binding ? binding.project_id : null;
}

// The same lookup, with WHEN the person was last seen there — which is what lets
// a caller tell a live binding from one that predates a project they have since
// created.
async function getLatestSessionBinding(ownerKey, identities) {
  await ensureSchema();
  const ids = (identities || []).filter(Boolean);
  if (!ids.length) return null;
  const result = await db.query(
    `SELECT s.project_id, s.last_seen_at
       FROM context_sessions s
       JOIN context_projects p
         ON p.project_id = s.project_id AND p.owner_key = s.owner_key
      WHERE s.owner_key = $1
        AND s.user_id = ANY($2)
        AND s.project_id IS NOT NULL
        AND s.status <> 'closed'
        AND p.archived_at IS NULL
      ORDER BY s.last_seen_at DESC
      LIMIT 1`,
    [ownerKey, ids],
    'org-system'
  );
  if (!result.rows.length) return null;
  const seen = result.rows[0].last_seen_at;
  return {
    project_id: result.rows[0].project_id,
    last_seen_at: seen instanceof Date ? seen.toISOString() : (seen || null),
  };
}

/**
 * Has this PERSON any work of their own in these workspaces: a project they
 * authored (archived included — archiving is not un-authoring), or a session
 * they bound to a project. `unattributedIn` names the one workspace whose
 * pre-attribution rows (owner_user_id NULL) are theirs too, their personal
 * workspace, for the same reason resolveActiveProject's tier 5 counts them.
 *
 * Asked only by the last tier of active-project resolution, which is reached
 * by somebody with nothing in the current workspace, so it is off the hot path.
 * Two EXISTS probes, each led by owner_key.
 */
async function hasOwnWorkInWorkspaces(ownerKeys, identities, { unattributedIn = null } = {}) {
  const keys = [...new Set((ownerKeys || []).filter(Boolean))];
  const ids = (identities || []).filter(Boolean);
  if (!keys.length || !ids.length) return false;
  await ensureSchema();
  const result = await db.query(
    `SELECT (
       EXISTS (
         SELECT 1 FROM context_projects
          WHERE owner_key = ANY($1::text[])
            AND (owner_user_id = ANY($2::text[]) OR (owner_user_id IS NULL AND owner_key = $3))
       )
       OR EXISTS (
         SELECT 1 FROM context_sessions
          WHERE owner_key = ANY($1::text[])
            AND user_id = ANY($2::text[])
            AND project_id IS NOT NULL
       )
     ) AS has_work`,
    [keys, ids, unattributedIn],
    'org-system'
  );
  return result.rows[0]?.has_work === true;
}

/**
 * Where THIS session is working — one primary-key seek, no scan.
 *
 * Different question from getLatestSessionBinding, which answers "where was this
 * PERSON last working, on any surface". That is a reasonable opening guess and a
 * terrible steady state: every hosted connector shared one session row, so a
 * browser tab's write moved the project an editor's next id-less read resolved
 * to. A connection's own binding has to win over anything another connection did.
 *
 * Archived and closed are excluded for the same reasons as the person-wide
 * lookup: a session the user ended, or a project they archived, is not where
 * their next write belongs.
 *
 * No user_id predicate, and that is safe rather than an omission: the only
 * caller passes a session id DERIVED server-side from (workspace, person,
 * credential) and hashed, never one a request supplied, so there is no id a
 * caller could present that belongs to somebody else.
 */
async function getSessionBinding(ownerKey, sessionId) {
  await ensureSchema();
  if (!ownerKey || !sessionId) return null;
  const result = await db.query(
    `SELECT s.project_id
       FROM context_sessions s
       JOIN context_projects p
         ON p.project_id = s.project_id AND p.owner_key = s.owner_key
      WHERE s.owner_key = $1
        AND s.session_id = $2
        AND s.project_id IS NOT NULL
        AND s.status <> 'closed'
        AND p.archived_at IS NULL`,
    [ownerKey, sessionId],
    'org-system'
  );
  return result.rows[0]?.project_id || null;
}

/**
 * Where THIS session is bound, INCLUDING a project since archived.
 *
 * getSessionBinding answers "where may this connection's next write go", so it
 * reads an archived project as no binding at all — and the caller then fell
 * through to whatever else resolved, and the write went somewhere the person had
 * not chosen (journey r5). This answers the other question: "where did this
 * connection say it was working", so a caller can refuse a write that would
 * otherwise land elsewhere and say why. A closed session, or a project that no
 * longer exists, is still no binding.
 */
async function getSessionBindingState(ownerKey, sessionId) {
  await ensureSchema();
  if (!ownerKey || !sessionId) return null;
  const result = await db.query(
    `SELECT s.project_id, (p.archived_at IS NOT NULL) AS archived
       FROM context_sessions s
       JOIN context_projects p
         ON p.project_id = s.project_id AND p.owner_key = s.owner_key
      WHERE s.owner_key = $1
        AND s.session_id = $2
        AND s.project_id IS NOT NULL
        AND s.status <> 'closed'`,
    [ownerKey, sessionId],
    'org-system'
  );
  const row = result.rows[0];
  return row ? { project_id: row.project_id, archived: row.archived === true } : null;
}

/**
 * Point THIS session at a project, creating its row if the connection has not
 * written anything yet.
 *
 * touchSession is deliberately UPDATE-only ("the session start is the only thing
 * that should create a row"), and on the hosted transport there IS no session
 * start: the row appears on the first write. So an explicit choice made before
 * any write — select a project, create one, open a brief — had nothing to
 * update and bound nothing at all. This is the one place allowed to insert.
 */
async function bindSession(ownerKey, sessionId, projectId, { userId = null, tool = 'claude_web', surfaceType = 'browser', transport = null } = {}) {
  await ensureSchema();
  if (!ownerKey || !sessionId || !projectId) return;
  await db.query(
    `INSERT INTO context_sessions
       (session_id, owner_key, user_id, tool, surface_type, project_id, status, last_seen_at, updated_at, transport)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), $7)
     ON CONFLICT (owner_key, session_id) DO UPDATE SET
       transport = COALESCE(EXCLUDED.transport, context_sessions.transport),
       project_id = EXCLUDED.project_id,
       -- Re-opening by choosing a project is a real intent; a session the user
       -- closed and then selected into must not stay invisible to resolution.
       status = 'active',
       -- COALESCE for the same reason saveSession uses it: a later write that
       -- happens not to carry an identity must not anonymise a session row.
       user_id = COALESCE(EXCLUDED.user_id, context_sessions.user_id),
       last_seen_at = NOW(),
       updated_at = NOW()`,
    [sessionId, ownerKey, userId, tool, surfaceType, projectId, transport],
    'org-system'
  );
}

// ─── finish_task reviews (hosted) ───────────────────────────────────────────
//
// What the last finish_task wrap-up review SHOWED a connection, per project, so
// the confirmation can clear exactly that and nothing added since (journey r4,
// BLOCKED 22). One row per (workspace, connection's session id, project),
// replaced by each review. Digests only (sha256 of each item's text, see
// contextSyncService.taskReviewDigest): the brief is encrypted at rest, and a
// plaintext copy of its questions here would undo that. Goes with its project
// (ON DELETE CASCADE) and with its workspace (dataErasureService
// OWNER_KEY_TABLES).
//
// Asked of the catalog first, like the indexes above: a table that exists
// costs a lookup and no lock on context_projects.
async function ensureTaskReviewsTable() {
  const present = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['context_task_reviews'], 'org-system');
  if (present.rows[0]?.present) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS context_task_reviews (
      owner_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
      reviewed JSONB NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_key, session_id, project_id)
    )`,
    [],
    'org-system'
  );
}

async function saveTaskReview(ownerKey, sessionId, projectId, reviewed) {
  await ensureSchema();
  if (!ownerKey || !sessionId || !projectId) return;
  await db.query(
    `INSERT INTO context_task_reviews (owner_key, session_id, project_id, reviewed, reviewed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (owner_key, session_id, project_id) DO UPDATE SET
       reviewed = EXCLUDED.reviewed,
       reviewed_at = NOW()`,
    [ownerKey, sessionId, projectId, JSON.stringify(reviewed)],
    'org-system'
  );
}

async function getTaskReview(ownerKey, sessionId, projectId) {
  await ensureSchema();
  if (!ownerKey || !sessionId || !projectId) return null;
  const result = await db.query(
    'SELECT reviewed FROM context_task_reviews WHERE owner_key = $1 AND session_id = $2 AND project_id = $3',
    [ownerKey, sessionId, projectId],
    'org-system'
  );
  return result.rows[0]?.reviewed || null;
}

async function deleteTaskReview(ownerKey, sessionId, projectId) {
  await ensureSchema();
  if (!ownerKey || !sessionId || !projectId) return;
  await db.query(
    'DELETE FROM context_task_reviews WHERE owner_key = $1 AND session_id = $2 AND project_id = $3',
    [ownerKey, sessionId, projectId],
    'org-system'
  );
}

// ─── Dead-binding notices (journey r5) ──────────────────────────────────────
//
// An end-of-session capture whose session was bound to a project since archived
// (or no longer shared with the person) is still filed where its route points.
// The next brief for THAT project says so, once: "the last session was filed
// here because the project this connection was bound to is archived", and how
// to restore it or pick another. One row per (workspace, person, project the
// capture landed in, dead project), consumed by the brief that shows it. Keyed
// by PERSON, because the note names the person's own session and a teammate
// opening the same project has no business reading it. Names only what the
// person could already read at the time: an unreadable project is an id.
// Goes with the project it points at (ON DELETE CASCADE) and with the
// workspace (dataErasureService OWNER_KEY_TABLES).
// AUTHORSHIP NOTICES (journey r7). An owner assigned somebody a project whose
// author could not be identified, or (for an owner) another owner took one over:
// said once in the person's next brief and once in their dashboard. Keyed by
// workspace and person; goes with the workspace and with the person
// (dataErasureService OWNER_KEY_TABLES and PERSON_KEYED_DELETES).
async function ensureAuthorNoticesTable() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS context_author_notices (
      notice_id     TEXT PRIMARY KEY,
      owner_key     TEXT NOT NULL,
      person_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      project_id    TEXT NOT NULL,
      project_name  TEXT,
      actor_label   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      brief_seen_at TIMESTAMPTZ,
      dash_seen_at  TIMESTAMPTZ
    )`,
    [],
    'org-system'
  );
}

async function ensureBindingNoticesTable() {
  const present = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['context_binding_notices'], 'org-system');
  if (present.rows[0]?.present) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS context_binding_notices (
      owner_key TEXT NOT NULL,
      person_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
      dead_project_id TEXT NOT NULL,
      dead_project_name TEXT,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_key, person_id, project_id, dead_project_id)
    )`,
    [],
    'org-system'
  );
}

async function saveBindingNotice(ownerKey, personId, projectId, { deadProjectId, deadProjectName = null, reason }) {
  await ensureSchema();
  if (!ownerKey || !projectId || !deadProjectId || !reason) return;
  await db.query(
    `INSERT INTO context_binding_notices (owner_key, person_id, project_id, dead_project_id, dead_project_name, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (owner_key, person_id, project_id, dead_project_id) DO UPDATE SET
       dead_project_name = EXCLUDED.dead_project_name,
       reason = EXCLUDED.reason,
       created_at = NOW()`,
    [ownerKey, personId || '', projectId, deadProjectId, deadProjectName, reason],
    'org-system'
  );
}

// Read and clear in one statement: a notice is shown once.
async function takeBindingNotices(ownerKey, personId, projectId) {
  await ensureSchema();
  if (!ownerKey || !projectId) return [];
  const result = await db.query(
    `DELETE FROM context_binding_notices
      WHERE owner_key = $1 AND person_id = $2 AND project_id = $3
      RETURNING dead_project_id, dead_project_name, reason, created_at`,
    [ownerKey, personId || '', projectId],
    'org-system'
  );
  return result.rows;
}

// Cheap COUNT for the per-plan workspace cap (included_projects). Top-level,
// non-archived rows only: subprojects are workstreams of an existing workspace
// (they never consume a slot), and archiving a project frees its slot.
async function countTopLevelProjects(ownerKey) {
  await ensureSchema();
  const result = await db.query(
    `SELECT COUNT(*)::int AS total
       FROM context_projects
      WHERE owner_key = $1 AND archived_at IS NULL AND parent_project_id IS NULL`,
    [ownerKey],
    'org-system'
  );
  return result.rows[0]?.total || 0;
}

async function listProjectNames(ownerKey, projectIds = []) {
  if (!projectIds.length) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT project_id, project_name
       FROM context_projects
      WHERE owner_key = $1
        AND project_id = ANY($2)`,
    [ownerKey, projectIds],
    'org-system'
  );
  return result.rows;
}

// Advances context_version, like archive and restore (see setProjectArchived),
// so a tab that read the project before the rename is refused on its next
// guarded save. `advanceVersion: false` is for a caller that renames and then,
// in the same request, makes a write guarded on the version it was sent: that
// write advances the version itself, and advancing it here first would make the
// request refuse its own write.
async function renameProject(actor, projectId, newName, { advanceVersion = true } = {}) {
  const ownerKey = workspace.defaultOwnerKey(actor) || 'org-system';
  await db.query(
    advanceVersion
      ? 'UPDATE context_projects SET project_name = $1, updated_at = NOW(), context_version = context_version + 1 WHERE project_id = $2 AND owner_key = $3'
      : 'UPDATE context_projects SET project_name = $1, updated_at = NOW() WHERE project_id = $2 AND owner_key = $3',
    [newName, projectId, ownerKey],
    'org-system'
  );
}

// Hard-delete a project the actor owns, plus the data that wouldn't go with it
// automatically. FK cascade removes events / shares / members; sessions unbind
// (ON DELETE SET NULL). Graph nodes ALSO only SET NULL on project delete, so we
// remove them explicitly — their edges / embeddings / evidence cascade off
// node_id. Everything is scoped by owner_key so one tenant can't delete
// another's project. Returns true when a project row was actually removed.
async function deleteProject(actor, projectId) {
  await ensureSchema();
  const ownerKey = workspace.defaultOwnerKey(actor) || 'org-system';
  await db.query(
    'DELETE FROM context_graph_nodes WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey],
    'org-system'
  );
  const result = await db.query(
    'DELETE FROM context_projects WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey],
    'org-system'
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Persist a project.
 *
 * COMPARE-AND-SWAP. Pass `expectedVersion` (the context_version of the row this
 * write was computed against) and the update only applies if the row still
 * carries it; the return value says whether it did. The version increments on
 * every write, guarded or not.
 *
 * Callers previously guarded concurrency by READING updated_at, comparing, and
 * then writing — three separate statements with a window between the check and
 * the act. A writer landing in that window was overwritten silently, which is
 * exactly the failure the check existed to prevent. The comparison has to happen
 * inside the write or it is not a guarantee.
 *
 * It guards on a counter rather than a timestamp deliberately. An earlier
 * version compared updated_at truncated to milliseconds — truncation was forced
 * because a JS ISO string cannot match a microsecond value that has been through
 * a Date, and it meant two writes inside the same millisecond both passed. A
 * counter cannot collide that way.
 *
 * Without expectedVersion the write is unconditional, exactly as before.
 */
async function saveProject(project, actor, { expectedVersion = null } = {}) {
  await ensureSchema();

  // NEVER WRITE THE FAIL-CLOSED SENTINEL BACK OVER THE CIPHERTEXT IT STANDS FOR.
  //
  // rowToProject replaces a context it cannot decrypt with { _decrypt_error: true }
  // so no caller ever sees raw ciphertext. Nothing checked for it on the way back
  // in, so the ordinary read-merge-save loop would encrypt that sentinel and store
  // it over the original — converting a RECOVERABLE key problem (wrong key row, a
  // rotation, a half-run backfill) into permanent loss, and reporting success.
  //
  // Refusing costs a failed write and an alarming log line. Proceeding costs the
  // project's entire history, silently, which is strictly worse.
  if (project?.context?._decrypt_error) {
    throw new Error(
      `saveProject: refusing to overwrite ${project.project_id} with an undecryptable-context marker — ` +
      'the stored ciphertext could not be read, so writing this would destroy it'
    );
  }

  // NEVER PERSIST A SECTION-FILTERED READ VIEW. contextSyncService marks the
  // context it hands a teammate (only the shared sections present); saving it
  // writes every other section back as empty. Registered Symbol, so no import.
  if (project?.context && project.context[Symbol.for('deerdawn.context.sectionFiltered')]) {
    throw new Error(
      `saveProject: refusing to persist a section-filtered context for ${project.project_id} — ` +
      'it omits every section outside the share policy, so writing it would erase them'
    );
  }

  let contextToStore = redactForStorage(project.context);
  if (encryption.shouldEncrypt(actor)) {
    contextToStore = await encryption.encryptContextObject(project.owner_key, contextToStore);
  }
  // The VALUES list binds $1..$13, so the guard takes the next slot. Derived
  // rather than written literally: a hard-coded index silently detaches the
  // moment a column is added, and Postgres reports it as an unrelated
  // "could not determine data type" rather than as a broken guard.
  const params = [
    project.project_id,
    project.owner_key,
    project.owner_user_id || null,
    project.visibility || 'private',
    project.project_name,
    project.aliases || [],
    project.linked_paths || [],
    project.linked_conversations || [],
    JSON.stringify(contextToStore),
    project.created_at,
    project.updated_at,
    project.workspace_key || null,
    project.parent_project_id || null,
  ];
  const guard = Number.isFinite(expectedVersion)
    ? `WHERE context_projects.context_version = $${params.length + 1}`
    : '';
  if (Number.isFinite(expectedVersion)) params.push(expectedVersion);
  const result = await db.query(
    `INSERT INTO context_projects
       (project_id, owner_key, owner_user_id, visibility, project_name, aliases, linked_paths, linked_conversations, context, created_at, updated_at, workspace_key, parent_project_id, context_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)
     ON CONFLICT (project_id) DO UPDATE SET
       owner_user_id       = COALESCE(context_projects.owner_user_id, EXCLUDED.owner_user_id),
       visibility          = EXCLUDED.visibility,
       project_name        = EXCLUDED.project_name,
       aliases             = EXCLUDED.aliases,
       linked_paths        = EXCLUDED.linked_paths,
       linked_conversations = EXCLUDED.linked_conversations,
       context             = EXCLUDED.context,
       updated_at          = EXCLUDED.updated_at,
       -- Tag the workspace when one is provided, but never null an existing key.
       workspace_key       = COALESCE(EXCLUDED.workspace_key, context_projects.workspace_key),
       -- Set directly (not COALESCE): a null must be able to clear the link so a
       -- subproject can be promoted back to top-level. Every update call-site
       -- spreads a full project read (which now carries parent_project_id), so a
       -- routine context save preserves the existing value rather than nulling it.
       parent_project_id   = EXCLUDED.parent_project_id,
       -- ALWAYS increments, guarded or not. An unguarded write still has to move
       -- the version, or a concurrent guarded writer would swap successfully
       -- against a row that changed under it.
       context_version     = context_projects.context_version + 1
     ${guard}`,
    params,
    'org-system'
  );

  const applied = result.rowCount > 0;
  // Only announce a write that happened. Publishing on a swap that lost would
  // tell every other machine to refresh for a change that was never made.
  if (applied) {
    publishContextEvent(`context:${project.owner_key}:${project.project_id}`, {
      type: 'project_updated',
      projectId: project.project_id,
    });
  }
  return { applied };
}

async function getProjectShare(projectId) {
  await ensureSchema();
  const shareResult = await db.query(
    `SELECT project_id, org_id, enabled, created_by, updated_by, created_at, updated_at
     FROM context_project_shares
     WHERE project_id = $1`,
    [projectId],
    'org-system'
  );
  const sectionsResult = await db.query(
    `SELECT project_id, section_key, can_view, can_edit, created_at, updated_at
     FROM context_project_share_sections
     WHERE project_id = $1
     ORDER BY section_key ASC`,
    [projectId],
    'org-system'
  );
  const membersResult = await db.query(
    `SELECT project_id, user_id, role_override, created_by, created_at, updated_at
     FROM context_project_members
     WHERE project_id = $1`,
    [projectId],
    'org-system'
  );

  return {
    share: shareResult.rows[0] || null,
    sections: sectionsResult.rows || [],
    members: membersResult.rows || [],
  };
}

// getProjectShare for MANY projects: one query per table, not three per project.
//
// Every list a teammate reads (the brief's related projects, the dashboard, the
// portfolio) resolved each project's share one at a time — 60 shared projects
// was 180 sequential queries before the first byte of the reply. Each table's
// primary key LEADS with project_id, so `project_id = ANY($1)` is an index scan,
// not a sweep of every workspace's rows (the graph-query blindspot). The ids
// come from rows the caller already loaded under its own owner key, which is
// what scopes the read; these tables carry no owner_key of their own.
//
// Returns Map(project_id -> { share, sections, members }), the same shape
// getProjectShare answers, with an empty entry for every id that has no rows.
async function getProjectShares(projectIds = []) {
  const ids = [...new Set((projectIds || []).filter(Boolean).map(String))];
  const out = new Map(ids.map((id) => [id, { share: null, sections: [], members: [] }]));
  if (!ids.length) return out;
  await ensureSchema();
  const [shareResult, sectionsResult, membersResult] = await Promise.all([
    db.query(
      `SELECT project_id, org_id, enabled, created_by, updated_by, created_at, updated_at
       FROM context_project_shares
       WHERE project_id = ANY($1::text[])`,
      [ids],
      'org-system'
    ),
    db.query(
      `SELECT project_id, section_key, can_view, can_edit, created_at, updated_at
       FROM context_project_share_sections
       WHERE project_id = ANY($1::text[])
       ORDER BY project_id ASC, section_key ASC`,
      [ids],
      'org-system'
    ),
    db.query(
      `SELECT project_id, user_id, role_override, created_by, created_at, updated_at
       FROM context_project_members
       WHERE project_id = ANY($1::text[])`,
      [ids],
      'org-system'
    ),
  ]);
  for (const row of shareResult.rows || []) {
    if (out.has(row.project_id)) out.get(row.project_id).share = row;
  }
  for (const row of sectionsResult.rows || []) {
    if (out.has(row.project_id)) out.get(row.project_id).sections.push(row);
  }
  for (const row of membersResult.rows || []) {
    if (out.has(row.project_id)) out.get(row.project_id).members.push(row);
  }
  return out;
}

async function upsertProjectShare(projectId, payload) {
  await ensureSchema();
  const {
    org_id,
    enabled = false,
    updated_by = null,
    created_by = null,
    sections = [],
    members = [],
  } = payload || {};

  await db.query(
    `INSERT INTO context_project_shares (project_id, org_id, enabled, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (project_id) DO UPDATE SET
       org_id = EXCLUDED.org_id,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [projectId, org_id, Boolean(enabled), created_by, updated_by],
    'org-system'
  );

  await db.query(
    'DELETE FROM context_project_share_sections WHERE project_id = $1',
    [projectId],
    'org-system'
  );
  for (const section of sections) {
    await db.query(
      `INSERT INTO context_project_share_sections (project_id, section_key, can_view, can_edit, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [projectId, section.section_key, Boolean(section.can_view), Boolean(section.can_edit)],
      'org-system'
    );
  }

  await db.query(
    'DELETE FROM context_project_members WHERE project_id = $1',
    [projectId],
    'org-system'
  );
  for (const member of members) {
    await db.query(
      `INSERT INTO context_project_members (project_id, user_id, role_override, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [projectId, member.user_id, member.role_override, updated_by],
      'org-system'
    );
  }
}

async function appendEvent(event) {
  await ensureSchema();
  await db.query(
    `INSERT INTO context_events
       (event_id, project_id, source_type, source_id, event_kind, delta, confidence, contributing_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.event_id,
      event.project_id,
      event.source_type,
      event.source_id,
      event.event_kind,
      JSON.stringify(redactForStorage(event.delta)),
      event.confidence,
      event.contributing_user_id || null,
      event.created_at,
    ],
    'org-system'
  );
}

// Distinct users who have contributed context to a project, strongest first.
// The foundation of social lock-in: shared context is visibly collectively built.
async function listProjectContributors(ownerKey, projectId) {
  if (!projectId) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT e.contributing_user_id AS user_id,
            COUNT(*)::int AS contributions,
            MAX(e.created_at) AS last_at
       FROM context_events e
       JOIN context_projects p ON p.project_id = e.project_id
      WHERE e.project_id = $1
        AND p.owner_key = $2
        AND e.contributing_user_id IS NOT NULL
      GROUP BY e.contributing_user_id
      ORDER BY contributions DESC, last_at DESC`,
    [projectId, ownerKey],
    'org-system'
  );
  return (result.rows || []).map((row) => ({
    user_id: row.user_id,
    contributions: Number(row.contributions),
    last_at: row.last_at instanceof Date ? row.last_at.toISOString() : row.last_at,
  }));
}

// Record a real session start on a project and return its ordinal plus the
// PREVIOUS session's timestamp — the two facts the day-two catch-up is built
// on. Single round-trip: the CTE reads prior history and inserts atomically.
//
// The history read is PER PERSON when a person is known. "Since your last
// session" has to mean YOURS: on a shared project every teammate writes rows
// under the same (owner_key, project_id), so a workspace-wide MAX(created_at)
// let Bob's session start move Alice's cutoff forward, and her next catch-up
// silently omitted everything Bob had done since she was last there.
//
// `identities` is the set of ids this person may appear under in stored rows
// (workspace.actorIdentities). Rows with NULL user_id carry no person: they only
// exist for loads made without a resolvable person (a system key, a legacy key
// with no owner). They are counted for a person only while the workspace has held
// at most one person, which keeps a solo workspace byte-for-byte identical to the
// old workspace-wide read (every row there is the one person's or NULL). Once the
// workspace has held two, such a row is nobody's: counting it for everyone made a
// new teammate's first session on a project with legacy rows read as their
// second, and moved their "since last session" cutoff to a load they never made.
// With no person at all, the read stays workspace-wide.
//
// Index: idx_context_session_loads_owner_project_user leads with
// (owner_key, project_id, user_id), so the person filter is resolved inside
// the index rather than on heap rows.
async function recordSessionLoad(ownerKey, projectId, { userId = null, identities = null, tool = null, transport = null } = {}) {
  await ensureSchema();
  const loadId = `sload_${require('crypto').randomUUID()}`;
  const ids = [...new Set([userId, ...(Array.isArray(identities) ? identities : [])].filter(Boolean))];
  const perPerson = ids.length > 0;
  const personFilter = perPerson
    ? 'AND (user_id = ANY($7::text[]) OR (user_id IS NULL AND (SELECT COUNT(*) FROM workspace_members wm WHERE wm.owner_key = $1) <= 1))'
    : '';
  // `last_tool` is the PREVIOUS load's tool, read under the same person filter
  // as the count, so the catch-up can say where the last session happened
  // ("… in ChatGPT"). One extra index seek on the same index, newest first.
  const result = await db.query(
    `WITH prior AS (
       SELECT COUNT(*)::int AS prior_count,
              MAX(created_at) AS last_at,
              MIN(created_at) AS first_at
         FROM context_session_loads
        WHERE owner_key = $1 AND project_id = $2
          ${personFilter}
     ), prev AS (
       SELECT tool AS last_tool
         FROM context_session_loads
        WHERE owner_key = $1 AND project_id = $2
          ${personFilter}
        ORDER BY created_at DESC
        LIMIT 1
     ), ins AS (
       INSERT INTO context_session_loads (load_id, owner_key, project_id, user_id, tool, transport)
       VALUES ($3, $1, $2, $4, $5, $6)
       RETURNING created_at
     )
     SELECT prior.prior_count, prior.last_at, prior.first_at, prev.last_tool, ins.created_at AS started_at
       FROM prior CROSS JOIN ins LEFT JOIN prev ON TRUE`,
    perPerson
      ? [ownerKey, projectId, loadId, userId, tool, transport, ids]
      : [ownerKey, projectId, loadId, userId, tool, transport],
    'org-system'
  );
  const row = result.rows?.[0] || {};
  const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
  return {
    session_number: Number(row.prior_count || 0) + 1,
    last_session_at: iso(row.last_at),
    first_session_at: iso(row.first_at) || iso(row.started_at),
    started_at: iso(row.started_at),
    last_tool: row.last_tool || null,
  };
}

// Workspace-level session accumulation — powers the ambient "Session N ·
// context since <month>" counter in the dashboard.
async function getSessionLoadStats(ownerKey) {
  await ensureSchema();
  const result = await db.query(
    `SELECT COUNT(*)::int AS total_sessions,
            MIN(created_at) AS first_session_at
       FROM context_session_loads
      WHERE owner_key = $1`,
    [ownerKey],
    'org-system'
  );
  const row = result.rows?.[0] || {};
  return {
    total_sessions: Number(row.total_sessions || 0),
    first_session_at: row.first_session_at instanceof Date
      ? row.first_session_at.toISOString()
      : row.first_session_at || null,
  };
}

async function getPreferences(ownerKey) {
  await ensureSchema();
  const result = await db.query(
    'SELECT preferences FROM injection_preferences WHERE owner_key = $1',
    [ownerKey],
    'org-system'
  );
  if (!result.rows.length) return null;
  return result.rows[0].preferences;
}

async function savePreferences(ownerKey, prefs) {
  await ensureSchema();
  await db.query(
    `INSERT INTO injection_preferences (owner_key, preferences, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (owner_key) DO UPDATE SET
       preferences = EXCLUDED.preferences,
       updated_at  = NOW()`,
    [ownerKey, JSON.stringify(prefs)],
    'org-system'
  );
  publishContextEvent(`context:${ownerKey}:preferences`, { type: 'preferences_updated' });
}

// An older project carries no repository identity, and the folder rule needs one
// to tell a directory below its linked path from a stranger's. Stamped once, and
// never over an identity it already has (see folderRule.js).
async function stampWorkspaceKeyIfMissing(ownerKey, projectId, workspaceKey) {
  await ensureSchema();
  if (!ownerKey || !projectId || !workspaceKey) return;
  await db.query(
    `UPDATE context_projects
        SET workspace_key = $3
      WHERE owner_key = $1 AND project_id = $2 AND (workspace_key IS NULL OR workspace_key = '')`,
    [ownerKey, projectId, workspaceKey],
    'org-system'
  );
}

// The project the user explicitly switched to for this codebase, or null.
// Person first, then the workspace default ('' — every row that predates the
// user_id column, and any pin set by an actor with no person behind it).
// `identities` is actorIdentities(actor): a pin may be stored under the person
// or, from an older key-authed write, under the key.
async function getWorkspacePointer(ownerKey, workspaceKey, identities = []) {
  await ensureSchema();
  if (!workspaceKey) return null;
  const ids = (identities || []).filter(Boolean);
  const result = await db.query(
    `SELECT active_project_id
       FROM context_workspace_pointers
      WHERE owner_key = $1 AND workspace_key = $2 AND (user_id = '' OR user_id = ANY($3))
      ORDER BY (user_id <> '') DESC, updated_at DESC
      LIMIT 1`,
    [ownerKey, workspaceKey, ids],
    'org-system'
  );
  return result.rows.length ? result.rows[0].active_project_id : null;
}

// userId null/'' writes the workspace default; anything else writes that
// person's own pin and leaves everybody else's resolution untouched.
async function setWorkspacePointer(ownerKey, workspaceKey, activeProjectId, userId = null) {
  await ensureSchema();
  await db.query(
    `INSERT INTO context_workspace_pointers (owner_key, workspace_key, user_id, active_project_id, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (owner_key, workspace_key, user_id) DO UPDATE SET
       active_project_id = EXCLUDED.active_project_id,
       updated_at        = NOW()`,
    [ownerKey, workspaceKey, userId || '', activeProjectId],
    'org-system'
  );
}

// WHO THE PRE-PERSON WORKSPACE PROFILE BELONGS TO.
//
// Before person_id existed the profile was written per workspace, so there is
// no record of who typed it. It is the founder's: the earliest person on the
// roster — COUNTING people since removed, so a founder who left does not hand
// their profile to whoever joined next — or, for a workspace with no roster
// rows at all, the earliest user who calls it home. Deliberately one person or
// nobody: a guess that could name a colleague is the leak this column exists to
// close. `keyExpr` is the SQL expression for the workspace key.
function globalFounderSql(keyExpr) {
  return `(SELECT c.user_id FROM (
             SELECT m.user_id, m.joined_at AS at, 0 AS src FROM workspace_members m WHERE m.owner_key = ${keyExpr}
             UNION ALL
             SELECT u.user_id, u.created_at AS at, 1 AS src FROM users u WHERE u.org_id = ${keyExpr}
           ) c
           WHERE c.user_id IS NOT NULL
           ORDER BY c.src, c.at ASC NULLS LAST, c.user_id
           LIMIT 1)`;
}

async function globalFounderId(ownerKey) {
  if (!ownerKey) return null;
  const result = await db.query(`SELECT ${globalFounderSql('$1')} AS user_id`, [ownerKey], 'org-system');
  return result.rows[0]?.user_id || null;
}

// THE PLATFORM SYSTEM KEY'S OWN PROFILE. The system key (middleware/auth.js:
// type 'system', id 'system-key', org 'org-system') is its own identity, and
// contextSyncService.globalPersonFor reads its profile as `system:system-key`
// — "it keeps the profile it always had". Its pre-person row is the
// 'org-system' workspace row, which has no founder, so the claim below left it
// '' and the key never read it again (scan 33 a/F5). That row is the key's.
const SYSTEM_GLOBAL_OWNER = 'org-system';
const SYSTEM_GLOBAL_PERSON = 'system:system-key';

// Who a pre-person row in `ownerKey` belongs to.
async function legacyGlobalClaimant(ownerKey) {
  if (ownerKey === SYSTEM_GLOBAL_OWNER) return SYSTEM_GLOBAL_PERSON;
  return globalFounderId(ownerKey);
}

// Hand every pre-person workspace profile to its founder, once, at boot — and
// the system workspace's to the system key. What cannot be resolved stays ''
// and is readable by nobody.
async function claimLegacyGlobals() {
  await db.query(
    `UPDATE context_globals g
        SET person_id = $2
      WHERE g.owner_key = $1
        AND g.person_id = ''
        AND NOT EXISTS (SELECT 1 FROM context_globals p
                         WHERE p.owner_key = g.owner_key AND p.person_id = $2)`,
    [SYSTEM_GLOBAL_OWNER, SYSTEM_GLOBAL_PERSON],
    'org-system'
  );
  await db.query(
    `UPDATE context_globals g
        SET person_id = f.user_id
       FROM (SELECT o.owner_key, ${globalFounderSql('o.owner_key')} AS user_id
               FROM context_globals o WHERE o.person_id = '') f
      WHERE g.owner_key = f.owner_key
        AND g.owner_key <> $1
        AND g.person_id = ''
        AND f.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM context_globals p
                         WHERE p.owner_key = g.owner_key AND p.person_id = f.user_id)`,
    [SYSTEM_GLOBAL_OWNER],
    'org-system'
  );
}

// One PERSON's profile in one workspace. No person, no profile: a caller that
// cannot say whose profile it wants gets nobody's (the service decides who a
// person-less actor stands for). A pre-person workspace row still unclaimed is
// returned to its founder and claimed for them in the same breath, and to
// nobody else.
async function getGlobal(ownerKey, personId) {
  await ensureSchema();
  if (!ownerKey || !personId) return null;
  const result = await db.query(
    `SELECT person_id, global FROM context_globals
      WHERE owner_key = $1 AND person_id IN ($2, '')`,
    [ownerKey, personId],
    'org-system'
  );
  const own = result.rows.find((row) => row.person_id === personId);
  if (own) return own.global;
  const legacy = result.rows.find((row) => row.person_id === '');
  if (!legacy) return null;
  const founder = await legacyGlobalClaimant(ownerKey).catch(() => null);
  if (!founder || founder !== personId) return null;
  await db.query(
    `UPDATE context_globals SET person_id = $2
      WHERE owner_key = $1 AND person_id = ''`,
    [ownerKey, personId],
    'org-system'
  ).catch(() => {}); // a concurrent claim or write got there first: the answer is the same
  return legacy.global;
}

// { global, reviewed_at } for this person's own row, or null. Does not claim a
// pre-person row: the service reads through getGlobal first, which does.
async function getGlobalReviewState(ownerKey, personId) {
  await ensureSchema();
  if (!ownerKey || !personId) return null;
  const result = await db.query(
    'SELECT global, profile_reviewed_at FROM context_globals WHERE owner_key = $1 AND person_id = $2',
    [ownerKey, personId],
    'org-system'
  );
  const row = result.rows[0];
  return row ? { global: row.global, reviewed_at: row.profile_reviewed_at || null } : null;
}

async function markGlobalReviewed(ownerKey, personId) {
  await ensureSchema();
  if (!ownerKey || !personId) return false;
  const result = await db.query(
    `UPDATE context_globals SET profile_reviewed_at = COALESCE(profile_reviewed_at, NOW())
      WHERE owner_key = $1 AND person_id = $2`,
    [ownerKey, personId],
    'org-system'
  );
  return (result.rowCount || 0) > 0;
}

// `auto: true` is an unattended write about the person (the local first-run
// seed, from files about them). It never settles the review note on a row that
// already exists: only the person's own save or dismissal does. A row it CREATES
// has nothing older to check, so that one starts reviewed.
async function saveGlobal(ownerKey, personId, global, { auto = false } = {}) {
  await ensureSchema();
  if (!ownerKey || typeof personId !== 'string' || !personId) {
    throw new Error('saveGlobal requires the person whose profile this is');
  }
  await db.query(
    `INSERT INTO context_globals (owner_key, person_id, global, updated_at, profile_reviewed_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (owner_key, person_id) DO UPDATE SET
       global              = EXCLUDED.global,
       updated_at          = NOW(),
       profile_reviewed_at = ${auto ? 'context_globals.profile_reviewed_at' : 'NOW()'}`,
    [ownerKey, personId, JSON.stringify(redactForStorage(global))],
    'org-system'
  );
  publishContextEvent(`context:${ownerKey}:global`, { type: 'global_updated' });
}

function rowToSession(row) {
  return {
    session_id: row.session_id,
    owner_key: row.owner_key,
    user_id: row.user_id || null,
    tool: row.tool,
    transport: row.transport || null,
    surface_type: row.surface_type,
    project_id: row.project_id || null,
    conversation_ref: row.conversation_ref || '',
    cwd: row.cwd || '',
    host: row.host || '',
    tab_id: row.tab_id || '',
    status: row.status,
    routing_state: row.routing_state || 'global_only',
    match_confidence: parseFloat(row.match_confidence || 0),
    last_confirmed_at: row.last_confirmed_at
      ? (row.last_confirmed_at instanceof Date ? row.last_confirmed_at.toISOString() : row.last_confirmed_at)
      : null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  };
}

function rowToGraphNode(row) {
  const metadata = row.metadata || {};
  return {
    node_id: row.node_id,
    owner_key: row.owner_key,
    project_id: row.project_id || null,
    node_type: row.node_type,
    canonical_key: row.canonical_key,
    title: normalizeGraphNodeTitle(row.title, row.node_type, metadata),
    summary: row.summary || '',
    metadata,
    confidence: parseFloat(row.confidence),
    source_session_id: row.source_session_id || '',
    source_tool: row.source_tool,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  };
}

function rowToGraphEdge(row) {
  return {
    edge_id: row.edge_id,
    owner_key: row.owner_key,
    project_id: row.project_id || null,
    edge_type: row.edge_type,
    from_node_id: row.from_node_id,
    to_node_id: row.to_node_id,
    summary: row.summary || '',
    metadata: row.metadata || {},
    confidence: parseFloat(row.confidence),
    source_session_id: row.source_session_id || '',
    source_tool: row.source_tool,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  };
}

function rowToGraphEvidence(row) {
  return {
    evidence_id: row.evidence_id,
    owner_key: row.owner_key,
    project_id: row.project_id || null,
    session_id: row.session_id,
    node_id: row.node_id || null,
    edge_id: row.edge_id || null,
    tool: row.tool,
    excerpt: row.excerpt,
    metadata: row.metadata || {},
    confidence: parseFloat(row.confidence),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function getSession(ownerKey, sessionId) {
  await ensureSchema();
  const result = await db.query(
    'SELECT * FROM context_sessions WHERE owner_key = $1 AND session_id = $2',
    [ownerKey, sessionId],
    'org-system'
  );
  if (!result.rows.length) return null;
  return rowToSession(result.rows[0]);
}

// `userIds` narrows the list to one person's sessions (every identity they may
// appear under). Omitted = the whole workspace, which only a caller that has
// already decided nothing here is anybody else's may ask for.
async function listSessions(ownerKey, { userIds = null } = {}) {
  await ensureSchema();
  const scoped = Array.isArray(userIds);
  const result = await db.query(
    scoped
      ? 'SELECT * FROM context_sessions WHERE owner_key = $1 AND user_id = ANY($2::text[]) ORDER BY last_seen_at DESC'
      : 'SELECT * FROM context_sessions WHERE owner_key = $1 ORDER BY last_seen_at DESC',
    scoped ? [ownerKey, userIds.filter(Boolean)] : [ownerKey],
    'org-system'
  );
  return result.rows.map(rowToSession);
}

/**
 * Peer agent sessions live on the same project right now.
 *
 * Served by the existing idx_context_sessions_owner_last_seen — an owner has a
 * handful of sessions, so filtering project_id and the liveness window after the
 * index seek costs nothing and no new index has to exist. Excluding the asking
 * session in SQL (rather than in the caller) means a solo agent gets an empty
 * array and the whole presence path short-circuits before it renders anything.
 */
async function listPeerSessions(ownerKey, projectId, excludeSessionId, windowSeconds) {
  await ensureSchema();
  if (!projectId) return [];
  const result = await db.query(
    `SELECT * FROM context_sessions
      WHERE owner_key = $1
        AND project_id = $2
        AND session_id <> $3
        AND status <> 'closed'
        AND last_seen_at > NOW() - ($4 || ' seconds')::interval
      ORDER BY last_seen_at DESC
      LIMIT 5`,
    [ownerKey, projectId, excludeSessionId || '', String(Math.max(1, Number(windowSeconds) || 0))],
    'org-system'
  );
  return result.rows.map(rowToSession);
}

/**
 * What each of those peers most recently touched — the DERIVED half of a claim.
 *
 * Reads source_session_id, which graph nodes have always carried, so a peer that
 * never declared a scope still shows up with a real area of work. Capped per
 * session in the caller; the LIMIT here is a blast-radius guard, not a page size.
 */
async function listRecentNodesBySessions(ownerKey, projectId, sessionIds, sinceSeconds) {
  await ensureSchema();
  const ids = (sessionIds || []).filter(Boolean);
  if (!projectId || !ids.length) return [];
  const result = await db.query(
    `SELECT source_session_id, title, node_type, updated_at
       FROM context_graph_nodes
      WHERE owner_key = $1
        AND project_id = $2
        AND source_session_id = ANY($3::text[])
        AND updated_at > NOW() - ($4 || ' seconds')::interval
      ORDER BY updated_at DESC
      LIMIT 40`,
    [ownerKey, projectId, ids, String(Math.max(1, Number(sinceSeconds) || 0))],
    'org-system'
  );
  return result.rows.map((row) => ({
    session_id: row.source_session_id,
    title: row.title,
    node_type: row.node_type,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

/**
 * Refresh a session's liveness with ONE indexed write and no read.
 *
 * saveSession is a read-then-upsert — fine at session start, too much to pay on
 * every call to a hot endpoint. This is the cheap path: a primary-key UPDATE that
 * touches nothing but the clock, and no-ops when the row does not exist yet (the
 * session start that creates it is the only thing that should).
 *
 * Without a refresh like this, presence would only be as fresh as an agent's last
 * WRITE, so an agent that read for an hour would look departed while it was busy
 * editing — the exact case presence exists for.
 */
// `identities`: when given, only a session that is unattributed or belongs to
// one of them is touched. The id comes off a query string, and without this a
// passive poll naming a colleague's session re-pointed it at the caller's
// project. Null (system and internal callers) keeps the unscoped update.
async function touchSession(ownerKey, sessionId, projectId, identities = null) {
  await ensureSchema();
  if (!ownerKey || !sessionId) return;
  const scoped = Array.isArray(identities);
  await db.query(
    `UPDATE context_sessions
        SET last_seen_at = NOW(),
            project_id = COALESCE($3, project_id)
      WHERE owner_key = $1 AND session_id = $2${scoped ? ' AND (user_id IS NULL OR user_id = ANY($4::text[]))' : ''}`,
    scoped ? [ownerKey, sessionId, projectId || null, identities.filter(Boolean)] : [ownerKey, sessionId, projectId || null],
    'org-system'
  );
}

async function saveSession(session) {
  await ensureSchema();
  await db.query(
    `INSERT INTO context_sessions
       (session_id, owner_key, user_id, tool, surface_type, project_id, conversation_ref, cwd, host, tab_id, status, routing_state, match_confidence, last_confirmed_at, created_at, updated_at, last_seen_at, transport)
     VALUES ($1, $2, $17, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $18)
     ON CONFLICT (owner_key, session_id) DO UPDATE SET
       -- COALESCE, not EXCLUDED: a later write that happens not to carry an
       -- identity must not anonymise a session that already had one.
       user_id = COALESCE(EXCLUDED.user_id, context_sessions.user_id),
       tool = EXCLUDED.tool,
       -- COALESCE: a write that cannot say how it connected keeps what was known.
       transport = COALESCE(EXCLUDED.transport, context_sessions.transport),
       surface_type = EXCLUDED.surface_type,
       project_id = EXCLUDED.project_id,
       conversation_ref = EXCLUDED.conversation_ref,
       cwd = EXCLUDED.cwd,
       host = EXCLUDED.host,
       tab_id = EXCLUDED.tab_id,
       status = EXCLUDED.status,
       routing_state = EXCLUDED.routing_state,
       match_confidence = EXCLUDED.match_confidence,
       last_confirmed_at = EXCLUDED.last_confirmed_at,
       updated_at = EXCLUDED.updated_at,
       last_seen_at = EXCLUDED.last_seen_at`,
    [
      session.session_id,
      session.owner_key,
      session.tool,
      session.surface_type,
      session.project_id || null,
      session.conversation_ref || '',
      session.cwd || '',
      session.host || '',
      session.tab_id || '',
      session.status,
      session.routing_state || 'global_only',
      session.match_confidence || 0,
      session.last_confirmed_at || null,
      session.created_at,
      session.updated_at,
      session.last_seen_at,
      session.user_id || null,
      session.transport || null,
    ],
    'org-system'
  );

  publishContextEvent(`context:${session.owner_key}:session:${session.session_id}`, {
    type: 'session_bound',
    sessionId: session.session_id,
    projectId: session.project_id || null,
  });
}

// upsertGraphNode's conflict: does this write leave the stored row's words
// alone? A write from another project than the row's home, or one marked so.
const KEEPS_TEXT = `($16::boolean OR (context_graph_nodes.project_id IS NOT NULL
  AND context_graph_nodes.project_id IS DISTINCT FROM EXCLUDED.project_id))`;

async function upsertGraphNode(rawNode) {
  await ensureSchema();
  // The canonical key is derived from the title, so it can carry the same
  // secret — but it is the row's IDENTITY, not text: masking it in place to a
  // shared "[REDACTED]" merged distinct entities on the unique index and lost
  // every relation that named them. secretSafeKey leaves an ordinary key alone
  // and swaps a secret-bearing one for a stable hash; getGraphNodeByCanonicalKey
  // applies the same function, so a lookup finds what this wrote.
  const node = {
    ...rawNode,
    title: redactSecrets(rawNode.title),
    summary: redactSecrets(rawNode.summary),
    canonical_key: secretSafeKey(rawNode.canonical_key),
    metadata: redactForStorage(rawNode.metadata || {}),
  };
  const normalizedTitle = normalizeGraphNodeTitle(node.title, node.node_type, node.metadata || {});
  // Hard cap on summary length — prevents blob nodes from dominating context budgets
  const cappedSummary = node.summary && node.summary.length > 280
    ? node.summary.slice(0, 279) + '…'
    : (node.summary || '');
  // A WORKSPACE-LEVEL NODE STAYS WORKSPACE-LEVEL. The conflict used to fill a
  // NULL project from whatever write landed on the row — COALESCE(existing,
  // incoming) — so any write carrying a project (an extraction in one repo, a
  // manage_memory default of the caller's active project) adopted a node the
  // whole team read into that one project, and a personal one hid it from
  // everybody else (scan 29). Only a write that NAMED the project for this very
  // entity (adopt_project: a caller's per-entity project_id, judged writable by
  // upsertWorkspaceEntities or POST /graph/nodes) may move it; any other keeps
  // it NULL, and the scope it carries says so. Auto-promotion is NOT naming —
  // its project is the brief's (scan 30: it adopted the team's decisions into a
  // member's personal project). A row that already has a project keeps it.
  const adopt = rawNode.adopt_project === true;
  // A NODE'S WORDS ARE ITS OWN PROJECT'S (scan 36 b/p114). The conflict used to
  // replace a stored summary under 40 characters, and merge the metadata, from
  // whichever write landed on the row. In a one-person workspace every write
  // takes the plain key, so project A's save of a decision project B had
  // recorded first wrote A's note ("because I am interviewing at Paddle next
  // week") onto B's node — and the first-invite split, which ignores A's
  // sighting, left it there for B's readers once B was shared. So a write from
  // any project but the node's home — or one the caller marks `keep_text`
  // because the project it came from is not the one it carries (a defaulted
  // save, upsertWorkspaceEntities) — changes none of the node's words: title,
  // summary, metadata and provenance stay as they are. Its evidence or sighting
  // still records that it was used there. A workspace-level node is judged by
  // its callers (landGraphWrite) as before.
  const keepText = rawNode.keep_text === true;
  const result = await db.query(
    `INSERT INTO context_graph_nodes
       (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (owner_key, node_type, canonical_key) DO UPDATE SET
       project_id = COALESCE(context_graph_nodes.project_id, CASE WHEN $15::boolean THEN EXCLUDED.project_id END),
       title = CASE WHEN ${KEEPS_TEXT} THEN context_graph_nodes.title ELSE EXCLUDED.title END,
       summary = CASE
         WHEN ${KEEPS_TEXT} THEN context_graph_nodes.summary
         WHEN length(context_graph_nodes.summary) < 40 THEN EXCLUDED.summary
         ELSE context_graph_nodes.summary
       END,
       metadata = CASE
         WHEN ${KEEPS_TEXT} THEN context_graph_nodes.metadata
         WHEN context_graph_nodes.project_id IS NULL AND NOT $15::boolean AND EXCLUDED.metadata->>'scope' = 'project'
           THEN context_graph_nodes.metadata || EXCLUDED.metadata || '{"scope":"workspace"}'::jsonb
         ELSE context_graph_nodes.metadata || EXCLUDED.metadata
       END,
       confidence = GREATEST(context_graph_nodes.confidence, EXCLUDED.confidence),
       source_session_id = CASE WHEN ${KEEPS_TEXT} THEN context_graph_nodes.source_session_id ELSE EXCLUDED.source_session_id END,
       source_tool = CASE WHEN ${KEEPS_TEXT} THEN context_graph_nodes.source_tool ELSE EXCLUDED.source_tool END,
       updated_at = CASE WHEN ${KEEPS_TEXT} THEN context_graph_nodes.updated_at ELSE EXCLUDED.updated_at END,
       last_seen_at = EXCLUDED.last_seen_at
     RETURNING *`,
    [
      node.node_id,
      node.owner_key,
      node.project_id || null,
      node.node_type,
      node.canonical_key,
      normalizedTitle,
      cappedSummary,
      JSON.stringify(node.metadata || {}),
      node.confidence,
      node.source_session_id || '',
      node.source_tool,
      node.created_at,
      node.updated_at,
      node.last_seen_at,
      adopt,
      keepText,
    ],
    'org-system'
  );
  return rowToGraphNode(result.rows[0]);
}

// Selection bookkeeping for nodes that already exist, by id. Merges ONLY the
// given metadata keys, raises confidence, bumps last_seen_at/updated_at — and
// never writes title, summary, project or any other metadata key. See
// trackWorkspaceSelections: routing this through upsertGraphNode wrote a
// reader's redacted copy of a node back over the stored one.
async function recordGraphNodeSelections(ownerKey, selections = [], selectedAt = new Date().toISOString()) {
  const rows = (selections || []).filter((entry) => entry?.node_id);
  if (!rows.length) return [];
  await ensureSchema();
  const payload = rows.map((entry) => ({
    node_id: String(entry.node_id),
    patch: redactForStorage(entry.metadata || {}),
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0,
  }));
  const result = await db.query(
    `UPDATE context_graph_nodes AS n
        SET metadata = n.metadata || u.patch,
            confidence = GREATEST(n.confidence, u.confidence),
            updated_at = $3,
            last_seen_at = $3
       FROM jsonb_to_recordset($2::jsonb) AS u(node_id text, patch jsonb, confidence double precision)
      WHERE n.owner_key = $1 AND n.node_id = u.node_id
      RETURNING n.*`,
    [ownerKey, JSON.stringify(payload), selectedAt],
    'org-system'
  );
  return result.rows.map(rowToGraphNode);
}

// AN EDGE KEEPS ITS OWN PROJECT'S PROVENANCE (scan 35 a/F2). An edge is unique
// per (owner, type, from, to) and keeps the first project that drew it, so a
// rebuild in ANOTHER project that draws the same two ends lands here too — a
// member's personal project between two workspace-level team nodes, say. The
// conflict used to overwrite the session, tool, summary, metadata and times
// with that project's, so the team's edge (still stamped with the team project,
// and so served to the team) carried the member's personal session id: the
// provenance round 34 (T5) took off the nodes. Now only a write for the edge's
// own project, or one adopting an edge that had none, refreshes any of it.
async function upsertGraphEdge(edge) {
  await ensureSchema();
  const own = '(context_graph_edges.project_id IS NULL OR context_graph_edges.project_id = EXCLUDED.project_id)';
  const result = await db.query(
    `INSERT INTO context_graph_edges
       (edge_id, owner_key, project_id, edge_type, from_node_id, to_node_id, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (owner_key, edge_type, from_node_id, to_node_id) DO UPDATE SET
       project_id = COALESCE(context_graph_edges.project_id, EXCLUDED.project_id),
       summary = CASE
         WHEN ${own} AND length(EXCLUDED.summary) > length(context_graph_edges.summary) THEN EXCLUDED.summary
         ELSE context_graph_edges.summary
       END,
       metadata = CASE WHEN ${own} THEN context_graph_edges.metadata || EXCLUDED.metadata ELSE context_graph_edges.metadata END,
       confidence = CASE WHEN ${own} THEN GREATEST(context_graph_edges.confidence, EXCLUDED.confidence) ELSE context_graph_edges.confidence END,
       source_session_id = CASE WHEN ${own} THEN EXCLUDED.source_session_id ELSE context_graph_edges.source_session_id END,
       source_tool = CASE WHEN ${own} THEN EXCLUDED.source_tool ELSE context_graph_edges.source_tool END,
       updated_at = CASE WHEN ${own} THEN EXCLUDED.updated_at ELSE context_graph_edges.updated_at END,
       last_seen_at = CASE WHEN ${own} THEN EXCLUDED.last_seen_at ELSE context_graph_edges.last_seen_at END
     RETURNING *`,
    [
      edge.edge_id,
      edge.owner_key,
      edge.project_id || null,
      edge.edge_type,
      edge.from_node_id,
      edge.to_node_id,
      redactSecrets(edge.summary || ''),
      JSON.stringify(redactForStorage(edge.metadata || {})),
      edge.confidence,
      edge.source_session_id || '',
      edge.source_tool,
      edge.created_at,
      edge.updated_at,
      edge.last_seen_at,
    ],
    'org-system'
  );
  return rowToGraphEdge(result.rows[0]);
}

async function addGraphEvidence(evidence) {
  await ensureSchema();
  const result = await db.query(
    `INSERT INTO context_graph_evidence
       (evidence_id, owner_key, project_id, session_id, node_id, edge_id, tool, excerpt, metadata, confidence, created_at, excerpt_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      evidence.evidence_id,
      evidence.owner_key,
      evidence.project_id || null,
      evidence.session_id,
      evidence.node_id || null,
      evidence.edge_id || null,
      evidence.tool,
      redactSecrets(evidence.excerpt),
      JSON.stringify(redactForStorage(evidence.metadata || {})),
      evidence.confidence,
      evidence.created_at,
      // Only what the caller says. A writer that does not say leaves NULL, which
      // the purge treats like any row written before the change: judged by its
      // text, never assumed to be the product's own words.
      evidence.excerpt_kind || null,
    ],
    'org-system'
  );
  return rowToGraphEvidence(result.rows[0]);
}

async function listGraphNodesForProject(ownerKey, projectId) {
  await ensureSchema();
  // Nodes belonging to the project OR connected by an edge in the project.
  // Collect the node ids via index-friendly subqueries (owner_key + project_id
  // is indexed on both tables), then join back to nodes by primary key. This
  // replaces a `LEFT JOIN ... ON from_node_id=... OR to_node_id=...` + `DISTINCT
  // n.*` that the planner could not index (O(nodes x edges)) — the cause of the
  // 8-13s /active latency and the resulting circuit-breaker 503s.
  // Best-effort: graph enrichment for /active must never trip the main breaker.
  const result = await db.queryBestEffort(
    `WITH node_ids AS (
       SELECT node_id FROM context_graph_nodes
        WHERE owner_key = $1 AND project_id = $2
       UNION
       SELECT from_node_id FROM context_graph_edges
        WHERE owner_key = $1 AND project_id = $2
       UNION
       SELECT to_node_id FROM context_graph_edges
        WHERE owner_key = $1 AND project_id = $2
     )
     SELECT n.*
       FROM context_graph_nodes n
       JOIN node_ids ni ON ni.node_id = n.node_id
      WHERE n.owner_key = $1
      ORDER BY n.last_seen_at DESC, n.title ASC`,
    [ownerKey, projectId],
    'org-system'
  );
  return result.rows.map(rowToGraphNode);
}

async function listGraphEdgesForProject(ownerKey, projectId) {
  await ensureSchema();
  const result = await db.queryBestEffort(
    `SELECT *
     FROM context_graph_edges
     WHERE owner_key = $1 AND project_id = $2
     ORDER BY last_seen_at DESC`,
    [ownerKey, projectId],
    'org-system'
  );
  return result.rows.map(rowToGraphEdge);
}

async function listGraphEvidenceForProject(ownerKey, projectId, limit = 25) {
  await ensureSchema();
  const result = await db.queryBestEffort(
    `SELECT *
     FROM context_graph_evidence
     WHERE owner_key = $1 AND project_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [ownerKey, projectId, limit],
    'org-system'
  );
  return result.rows.map(rowToGraphEvidence);
}

async function getGraphNode(ownerKey, nodeId) {
  await ensureSchema();
  const result = await db.query(
    'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND node_id = $2',
    [ownerKey, nodeId],
    'org-system'
  );
  if (!result.rows.length) return null;
  return rowToGraphNode(result.rows[0]);
}

// The nodes on the far end of an edge, fetched in ONE owner-scoped pass.
//
// The visibility filter needs to judge an edge by its endpoints, and an endpoint
// is routinely a node the caller's graph does not itself contain — every edge on
// a single-node graph is like that. owner_key leads the predicate, so this uses
// the same (owner_key, ...) index every other node read does; never a lookup per
// edge, which is the per-node shape that measured 14,219ms on evidence.
async function listGraphNodesByIds(ownerKey, nodeIds = []) {
  const ids = [...new Set((nodeIds || []).filter(Boolean))];
  if (!ids.length) return [];
  await ensureSchema();
  const result = await db.query(
    'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND node_id = ANY($2)',
    [ownerKey, ids],
    'org-system'
  );
  return result.rows.map(rowToGraphNode);
}

// THE SAME ENTITY IN ANOTHER PROJECT, by identity rather than by row. Since the
// team-era landing rule (and the first invite's split) gave each project its
// own `<key>::in.<project>` copy, no row is shared between two projects any
// more, so "a node this project and that one both touch" found nothing and a
// founder's brief lost its Related projects line at the first invite (scan
// 36). Grouped the way the portfolio groups: on the key before `::in.`.
// Returns, per pair, this project's node and the other project's, so the
// caller can judge BOTH against what the reader may see. Project roots are
// not an entity two projects share. Owner-scoped on both sides.
async function listSameEntityNodesInOtherProjects(ownerKey, projectId, { limit = 50 } = {}) {
  if (!ownerKey || !projectId) return [];
  await ensureSchema();
  const result = await db.queryBestEffort(
    `WITH mine AS (
       SELECT node_id, node_type, split_part(canonical_key, '::in.', 1) AS entity_key
         FROM context_graph_nodes
        WHERE owner_key = $1 AND project_id = $2 AND node_type <> 'project'
     )
     SELECT m.node_id AS own_node_id, o.*
       FROM context_graph_nodes o
       JOIN mine m ON m.node_type = o.node_type AND m.entity_key = split_part(o.canonical_key, '::in.', 1)
      WHERE o.owner_key = $1 AND o.project_id IS NOT NULL AND o.project_id <> $2
      ORDER BY o.last_seen_at DESC
      LIMIT $3`,
    [ownerKey, projectId, limit],
    'org-system'
  );
  return (result?.rows || []).map((row) => ({ own_node_id: row.own_node_id, node: rowToGraphNode(row) }));
}

async function getGraphNodeByCanonicalKey(ownerKey, nodeType, canonicalKey) {
  await ensureSchema();
  const result = await db.query(
    `SELECT * FROM context_graph_nodes
     WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3`,
    // The same transformation upsertGraphNode stores the key under.
    [ownerKey, nodeType, secretSafeKey(canonicalKey)],
    'org-system'
  );
  if (!result.rows.length) return null;
  return rowToGraphNode(result.rows[0]);
}

// Every node of one type whose canonical key begins with `prefix`: the scoped
// keys an entity is written under when a node its caller cannot see holds the
// plain one (contextSyncService upsertWorkspaceEntities, scopedEntityKey).
// starts_with, not LIKE: keys carry `_`, which LIKE reads as a wildcard.
async function listGraphNodesByKeyPrefix(ownerKey, nodeType, prefix, limit = 50) {
  if (!ownerKey || !nodeType || !prefix) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT * FROM context_graph_nodes
      WHERE owner_key = $1 AND node_type = $2 AND starts_with(canonical_key, $3)
      ORDER BY updated_at DESC
      LIMIT $4`,
    [ownerKey, nodeType, prefix, limit],
    'org-system'
  );
  return result.rows.map(rowToGraphNode);
}

function escapeLikeTerm(term) {
  return String(term).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// `textTerms`: keep only nodes whose title, summary, canonical_key or metadata
// contains at least one term (case-insensitive). The text filter has to live in
// the query: a caller that fetches the newest N and filters in memory can never
// find anything older than N, which made every entity past the 30 most recently
// seen unfindable and unresolvable. owner_key still leads the predicate, so the
// (owner_key, last_seen_at) index serves the ordering and the scan stays inside
// one owner's rows — never a cross-owner sweep.
async function listGraphNodes(ownerKey, { nodeTypes = [], projectId = null, limit = 100, textTerms = [] } = {}) {
  await ensureSchema();
  const clauses = ['owner_key = $1'];
  const params = [ownerKey];

  if (projectId) {
    params.push(projectId);
    clauses.push(`project_id = $${params.length}`);
  }

  if (nodeTypes.length) {
    params.push(nodeTypes);
    clauses.push(`node_type = ANY($${params.length})`);
  }

  const patterns = (Array.isArray(textTerms) ? textTerms : [])
    .map((term) => String(term || '').trim())
    .filter(Boolean)
    .map((term) => `%${escapeLikeTerm(term)}%`);
  if (patterns.length) {
    params.push(patterns);
    const p = `$${params.length}`;
    clauses.push(`(title ILIKE ANY(${p}) OR summary ILIKE ANY(${p}) OR canonical_key ILIKE ANY(${p}) OR metadata::text ILIKE ANY(${p}))`);
  }

  params.push(limit);
  const result = await db.query(
    `SELECT * FROM context_graph_nodes
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_seen_at DESC, confidence DESC, title ASC
     LIMIT $${params.length}`,
    params,
    'org-system'
  );
  return result.rows.map(rowToGraphNode);
}

async function listGraphEdgesForNode(ownerKey, nodeId) {
  await ensureSchema();
  const result = await db.query(
    `SELECT *
     FROM context_graph_edges
     WHERE owner_key = $1 AND (from_node_id = $2 OR to_node_id = $2)
     ORDER BY last_seen_at DESC`,
    [ownerKey, nodeId],
    'org-system'
  );
  return result.rows.map(rowToGraphEdge);
}

async function listGraphEvidenceForNode(ownerKey, nodeId, limit = 25) {
  await ensureSchema();
  const result = await db.query(
    `SELECT *
     FROM context_graph_evidence
     WHERE owner_key = $1 AND node_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [ownerKey, nodeId, limit],
    'org-system'
  );
  return result.rows.map(rowToGraphEvidence);
}

async function listRecentGraphFacts(ownerKey, limit = 40) {
  await ensureSchema();
  // Best-effort: feeds /active graph enrichment; isolated from the main breaker.
  const nodeResult = await db.queryBestEffort(
    `SELECT * FROM context_graph_nodes
     WHERE owner_key = $1
     ORDER BY last_seen_at DESC
     LIMIT $2`,
    [ownerKey, limit],
    'org-system'
  );
  const edgeResult = await db.queryBestEffort(
    `SELECT * FROM context_graph_edges
     WHERE owner_key = $1
     ORDER BY last_seen_at DESC
     LIMIT $2`,
    [ownerKey, limit],
    'org-system'
  );
  const evidenceResult = await db.queryBestEffort(
    `SELECT * FROM context_graph_evidence
     WHERE owner_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [ownerKey, limit],
    'org-system'
  );
  return {
    nodes: nodeResult.rows.map(rowToGraphNode),
    edges: edgeResult.rows.map(rowToGraphEdge),
    evidence: evidenceResult.rows.map(rowToGraphEvidence),
  };
}

async function listAllGraphData(ownerKey) {
  await ensureSchema();
  const [nodeResult, edgeResult, evidenceResult] = await Promise.all([
    db.query('SELECT * FROM context_graph_nodes WHERE owner_key = $1 ORDER BY last_seen_at DESC', [ownerKey], 'org-system'),
    db.query('SELECT * FROM context_graph_edges WHERE owner_key = $1 ORDER BY last_seen_at DESC', [ownerKey], 'org-system'),
    db.query('SELECT * FROM context_graph_evidence WHERE owner_key = $1 ORDER BY created_at DESC LIMIT 500', [ownerKey], 'org-system'),
  ]);
  return {
    nodes: nodeResult.rows.map(rowToGraphNode),
    edges: edgeResult.rows.map(rowToGraphEdge),
    evidence: evidenceResult.rows.map(rowToGraphEvidence),
  };
}

async function upsertGraphEmbedding(embedding) {
  await ensureSchema();
  await db.query(
    `INSERT INTO context_graph_embeddings
       (owner_key, target_kind, target_id, model, dimensions, vector, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (owner_key, target_kind, target_id, model) DO UPDATE SET
       dimensions = EXCLUDED.dimensions,
       vector = EXCLUDED.vector,
       updated_at = NOW()`,
    [
      embedding.owner_key,
      embedding.target_kind,
      embedding.target_id,
      embedding.model,
      embedding.dimensions,
      JSON.stringify(embedding.vector || []),
    ],
    'org-system'
  );
}

async function getGraphEmbeddings(ownerKey, targetKind, targetIds, model = null) {
  await ensureSchema();
  if (!targetIds.length) return [];
  const result = await db.query(
    `SELECT *
     FROM context_graph_embeddings
     WHERE owner_key = $1
       AND target_kind = $2
       AND target_id = ANY($3)
       ${model ? 'AND model = $4' : ''}
     ORDER BY updated_at DESC`,
    model ? [ownerKey, targetKind, targetIds, model] : [ownerKey, targetKind, targetIds],
    'org-system'
  );
  return result.rows.map((row) => ({
    owner_key: row.owner_key,
    target_kind: row.target_kind,
    target_id: row.target_id,
    model: row.model,
    dimensions: row.dimensions,
    vector: Array.isArray(row.vector) ? row.vector.map(Number) : [],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

// Record a co-occurrence between two projects, strengthening their affinity.
// Idempotent-by-pair: each observation increments the persisted count. Pairs are
// stored canonically so direction never creates a duplicate row.
async function recordProjectAffinity(ownerKey, projectId1, projectId2) {
  if (!projectId1 || !projectId2 || projectId1 === projectId2) return;
  await ensureSchema();
  const [a, b] = projectId1 < projectId2 ? [projectId1, projectId2] : [projectId2, projectId1];
  await db.query(
    `INSERT INTO context_project_affinity (owner_key, project_a, project_b, co_occurrence_count, last_seen_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (owner_key, project_a, project_b) DO UPDATE SET
       co_occurrence_count = context_project_affinity.co_occurrence_count + 1,
       last_seen_at = NOW()`,
    [ownerKey, a, b],
    'org-system'
  );
}

// Projects most often worked alongside the given one, strongest first.
async function listProjectAffinities(ownerKey, projectId, limit = 5) {
  if (!projectId) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT project_a, project_b, co_occurrence_count, last_seen_at
       FROM context_project_affinity
      WHERE owner_key = $1 AND (project_a = $2 OR project_b = $2)
      ORDER BY co_occurrence_count DESC, last_seen_at DESC
      LIMIT $3`,
    [ownerKey, projectId, limit],
    'org-system'
  );
  return (result.rows || []).map((row) => ({
    project_id: row.project_a === projectId ? row.project_b : row.project_a,
    co_occurrence_count: Number(row.co_occurrence_count),
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  }));
}

// Deletes all rows belonging to the org-system owner — used by tests only.
// Test-only reset. Runs as ONE transaction and deletes children before parents.
//
// Previously this issued 11 independent DELETEs on separate pool connections, so another
// connection could observe a half-cleared database — projects gone while sessions still
// referenced them. Combined with tests that share owner_key 'org-system', that produced
// intermittent `context_sessions_project_id_fkey` violations when one test's in-flight
// write landed against another test's partially-completed reset. A single transaction
// makes the reset atomic: other connections see the database either fully populated or
// fully cleared, never mid-wipe.
async function clearAll() {
  await ensureSchema();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', 'org-system']);

    // Child-before-parent. context_events cascades and context_sessions is SET NULL on
    // project delete, but explicit ordering keeps the reset correct if either FK is ever
    // tightened, and avoids relying on cascade behaviour for test isolation.
    await client.query('DELETE FROM context_graph_evidence   WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_graph_edges      WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_graph_nodes      WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_graph_embeddings WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_project_affinity WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_sessions         WHERE owner_key = $1', ['org-system']);
    await client.query(
      `DELETE FROM context_events WHERE project_id IN
         (SELECT project_id FROM context_projects WHERE owner_key = $1)`,
      ['org-system']
    );
    await client.query('DELETE FROM context_projects           WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM injection_preferences      WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_workspace_pointers WHERE owner_key = $1', ['org-system']);
    await client.query('DELETE FROM context_globals            WHERE owner_key = $1', ['org-system']);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteGraphNode(ownerKey, nodeId) {
  await ensureSchema();
  await db.query('DELETE FROM context_graph_evidence WHERE owner_key=$1 AND node_id=$2', [ownerKey, nodeId], 'org-system');
  await db.query('DELETE FROM context_graph_edges WHERE owner_key=$1 AND (from_node_id=$2 OR to_node_id=$2)', [ownerKey, nodeId], 'org-system');
  await db.query('DELETE FROM context_graph_nodes WHERE owner_key=$1 AND node_id=$2', [ownerKey, nodeId], 'org-system');
}

function rowToSkill(row) {
  return {
    skill_id: row.skill_id,
    owner_key: row.owner_key,
    project_id: row.project_id || null,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    markdown_content: row.markdown_content,
    visibility: row.visibility || 'private',
    enabled: row.enabled !== false,
    created_by: row.created_by || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function upsertWorkspaceSkill(skill) {
  await ensureSchema();
  const result = await db.query(
    `INSERT INTO workspace_skills
       (skill_id, owner_key, project_id, slug, name, description, markdown_content, visibility, enabled, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
     ON CONFLICT (owner_key, slug) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       markdown_content = EXCLUDED.markdown_content,
       visibility = EXCLUDED.visibility,
       enabled = EXCLUDED.enabled,
       -- AUTHORSHIP IS SET ON INSERT AND NEVER BY AN EDIT. An owner correcting a
       -- colleague's skill must not become its author, or the next authority
       -- check reads the editor back as the person to protect it from.
       --
       -- That includes a row with NO author. NULL means the skill predates
       -- authorship and belongs to the workspace: anyone who may write may edit
       -- it. This used to COALESCE the editor in, so the first person to fix a
       -- typo in a legacy skill became its sole author and every other member
       -- was locked out of it from then on.
       created_by = workspace_skills.created_by,
       updated_at = NOW()
     RETURNING *`,
    [
      skill.skill_id,
      skill.owner_key,
      skill.project_id || null,
      skill.slug,
      skill.name,
      skill.description || '',
      skill.markdown_content,
      skill.visibility || 'private',
      skill.enabled !== false,
      skill.created_by || null,
    ],
    'org-system'
  );
  return rowToSkill(result.rows[0]);
}

// Metadata-only list (no markdown_content) scoped to the owner. Workspace-wide
// skills (project_id NULL) always match; project-scoped skills match only the
// active project. Disabled skills are excluded, except for the export, which
// asks for them (`includeDisabled`): a switched-off skill is still the person's,
// and was erased at deletion with no copy while this list left it out.
async function listWorkspaceSkills(ownerKey, projectId = null, { includeDisabled = false } = {}) {
  await ensureSchema();
  const result = await db.query(
    `SELECT skill_id, owner_key, project_id, slug, name, description, visibility, enabled, created_by, created_at, updated_at
       FROM workspace_skills
      WHERE owner_key = $1
        AND (project_id IS NULL OR project_id = $2)
        ${includeDisabled ? '' : 'AND enabled'}
      ORDER BY updated_at DESC`,
    [ownerKey, projectId],
    'org-system'
  );
  return result.rows.map((row) => ({
    skill_id: row.skill_id,
    owner_key: row.owner_key,
    project_id: row.project_id || null,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    visibility: row.visibility || 'private',
    enabled: row.enabled !== false,
    created_by: row.created_by || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

// Full skill (incl. markdown_content) by skill_id OR slug, owner-scoped.
async function getWorkspaceSkill(ownerKey, idOrSlug) {
  await ensureSchema();
  const result = await db.query(
    `SELECT * FROM workspace_skills
      WHERE owner_key = $1 AND (skill_id = $2 OR slug = $2)
      LIMIT 1`,
    [ownerKey, idOrSlug],
    'org-system'
  );
  if (!result.rows.length) return null;
  return rowToSkill(result.rows[0]);
}

async function deleteWorkspaceSkill(ownerKey, skillId) {
  await ensureSchema();
  const result = await db.query(
    'DELETE FROM workspace_skills WHERE owner_key = $1 AND skill_id = $2',
    [ownerKey, skillId],
    'org-system'
  );
  return (result.rowCount || 0) > 0;
}

// ── Portfolio (cross-project) ────────────────────────────────────────────────
//
// WHY THIS IS AN EVIDENCE QUERY, NOT A canonical_key GROUP-BY.
//
// The obvious formulation — GROUP BY canonical_key HAVING count(distinct
// project_id) > 1 — returns zero rows, always, and the reason is one line of
// DDL: context_graph_nodes carries UNIQUE (owner_key, node_type, canonical_key).
// A canonical key exists exactly ONCE per owner. On top of that, upsertGraphNode
// resolves the conflict with `project_id = COALESCE(existing, EXCLUDED)`, so a
// node keeps the FIRST project it was seen in and every later sighting in a
// different project is invisible in the nodes table.
//
// The per-sighting record is context_graph_evidence: one row per time a node was
// observed, each stamped with the project it was observed in. So the set of
// projects an entity appears in is (its home project) ∪ (the projects on its
// evidence), and "shared" means that set has more than one member.
//
// WHY THE SIGHTINGS ARE COLLECTED ONCE, NOT PER NODE.
//
// The first version of this asked for the projects of ONE node at a time, in a
// LATERAL subquery: `WHERE e.node_id = n.node_id`. context_graph_evidence has no
// index on node_id — it is indexed (owner_key, project_id, created_at) for the
// timeline reads — and it is the largest table in the schema, holding every
// owner's observations. So each node cost a full sequential scan of everybody's
// evidence, and the query cost scaled as (this owner's nodes) x (all evidence).
// Measured on a 2,000-node / 150,000-evidence-row fixture: 14,219ms, which is
// well past the 8s DB circuit breaker — the portfolio page failed to load, and
// it failed WORSE the more the account used the product.
//
// Collecting every sighting in one owner-scoped pass and joining once is the
// same answer at 178ms on the same fixture. The evidence side now filters on
// owner_key, which is the leading column of the index it already has.
//
// ONE ENTITY CAN BE SEVERAL NODES (scan 34). Where a plain key is somebody
// else's row, a project's writes land on its own `<key>::in.<project>` copy
// (contextSyncService landGraphWrite) — and the rebuild never lands on a row
// homed in another project, not even one of the same person's (a later
// visibility change would turn that evidence into a read grant). So one
// person's "Postgres" in two of their projects is two nodes, each seen in one
// project, and a per-node count calls neither cross-project. The copies share
// the plain key (the part before `::in.`), so a node is returned when its
// ENTITY — every node of its type with that plain key — spans more than one
// project; `entity_key` says which, and portfolioService groups what the
// reader may read. Same single owner-scoped pass: the grouping is over rows
// this query already reads.
// The portfolio's grouping key: a node's plain key with its scope stripped and
// a long base cut exactly as a scoped key's is (workspaceService.boundedKeyBase,
// scan 36), so a long plain row and its copies group as one entity.
// Built on first use, not at module load: workspaceService and this store
// require each other through the service layer, so which one finishes loading
// first depends on who is required first, and a load-time call here could find
// workspace.boundedKeyBaseSql still undefined and throw at boot.
let entityKeySqlCache = null;
function entityKeySql() {
  if (!entityKeySqlCache) entityKeySqlCache = workspace.boundedKeyBaseSql('split_part(n.canonical_key, \'::in.\', 1)');
  return entityKeySqlCache;
}

async function listCrossProjectEntities(ownerKey, { limit = 50 } = {}) {
  await ensureSchema();
  const result = await db.query(
    `WITH sightings AS (
            SELECT n.node_id, n.project_id AS pid
              FROM context_graph_nodes n
             WHERE n.owner_key = $1 AND n.project_id IS NOT NULL
             UNION
            SELECT e.node_id, e.project_id
              FROM context_graph_evidence e
             WHERE e.owner_key = $1 AND e.node_id IS NOT NULL AND e.project_id IS NOT NULL
          ),
          per_node AS (
            SELECT n.node_id,
                   n.node_type,
                   ${entityKeySql()} AS entity_key,
                   ARRAY_AGG(DISTINCT s.pid) AS project_ids,
                   COUNT(DISTINCT s.pid)::int AS project_count
              FROM context_graph_nodes n
              JOIN sightings s ON s.node_id = n.node_id
             WHERE n.owner_key = $1
             GROUP BY n.node_id
          ),
          entities AS (
            SELECT p.node_type, p.entity_key
              FROM per_node p, unnest(p.project_ids) AS pid
             GROUP BY p.node_type, p.entity_key
            HAVING COUNT(DISTINCT pid) > 1
          )
     SELECT n.node_id,
            n.project_id,
            n.node_type,
            n.canonical_key,
            n.title,
            n.summary,
            n.metadata,
            n.updated_at,
            p.entity_key,
            p.project_ids,
            p.project_count
       FROM per_node p
       JOIN entities x ON x.node_type = p.node_type AND x.entity_key = p.entity_key
       JOIN context_graph_nodes n ON n.node_id = p.node_id
      ORDER BY p.project_count DESC, n.updated_at DESC
      LIMIT $2`,
    [ownerKey, limit],
    'org-system'
  );
  return result.rows.map((row) => ({
    ...rowToGraphNode(row),
    entity_key: row.entity_key,
    project_ids: row.project_ids || [],
    project_count: row.project_count,
    shared_reason: 'cross_project',
  }));
}

// Workspace-scoped entities: written with scope 'workspace' (project_id NULL by
// construction — see upsertWorkspaceEntities). They are portfolio-level by
// declaration rather than by observation, so they belong in the shared list even
// with no evidence behind them yet.
async function listWorkspaceScopedEntities(ownerKey, { limit = 50 } = {}) {
  await ensureSchema();
  const result = await db.query(
    `SELECT node_id, project_id, node_type, canonical_key, title, summary, metadata, updated_at
       FROM context_graph_nodes
      WHERE owner_key = $1
        AND metadata->>'scope' = 'workspace'
      ORDER BY updated_at DESC
      LIMIT $2`,
    [ownerKey, limit],
    'org-system'
  );
  return result.rows.map((row) => ({
    ...rowToGraphNode(row),
    project_ids: [],
    project_count: 0,
    shared_reason: 'workspace_scope',
  }));
}

// ── Share tokens ─────────────────────────────────────────────────────────────

function rowToShareToken(row) {
  if (!row) return null;
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v || null));
  return {
    token: row.token,
    owner_key: row.owner_key,
    project_id: row.project_id,
    visibility: row.visibility,
    created_by: row.created_by || null,
    created_at: iso(row.created_at),
    revoked_at: iso(row.revoked_at),
    last_viewed_at: iso(row.last_viewed_at),
    view_count: row.view_count || 0,
    ref_code: row.ref_code || null,
    conversion_count: row.conversion_count || 0,
  };
}

async function createShareToken({ token, owner_key, project_id, visibility = 'unlisted', created_by = null, ref_code = null }) {
  await ensureSchema();
  const result = await db.query(
    `INSERT INTO context_share_tokens (token, owner_key, project_id, visibility, created_by, ref_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [token, owner_key, project_id, visibility, created_by, ref_code],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

// Public lookup: NO owner_key, because the caller is an anonymous visitor holding
// only the token. Revoked rows are returned too — the caller decides between
// "this link was turned off" and "no such link", which are different pages.
async function getShareTokenByToken(token) {
  await ensureSchema();
  const result = await db.query(
    'SELECT * FROM context_share_tokens WHERE token = $1',
    [token],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

async function listShareTokens(ownerKey, { includeRevoked = false } = {}) {
  await ensureSchema();
  const where = includeRevoked ? '' : ' AND revoked_at IS NULL';
  const result = await db.query(
    `SELECT * FROM context_share_tokens WHERE owner_key = $1${where} ORDER BY created_at DESC`,
    [ownerKey],
    'org-system'
  );
  return result.rows.map(rowToShareToken);
}

async function setShareTokenVisibility(ownerKey, token, visibility) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE context_share_tokens SET visibility = $3
      WHERE token = $2 AND owner_key = $1 AND revoked_at IS NULL
      RETURNING *`,
    [ownerKey, token, visibility],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

async function revokeShareToken(ownerKey, token) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE context_share_tokens SET revoked_at = NOW()
      WHERE token = $2 AND owner_key = $1 AND revoked_at IS NULL
      RETURNING *`,
    [ownerKey, token],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

// Fire-and-forget from the public route: a counter failure must never stop a
// visitor seeing the page.
async function recordShareTokenView(token) {
  await ensureSchema();
  await db.query(
    'UPDATE context_share_tokens SET view_count = view_count + 1, last_viewed_at = NOW() WHERE token = $1',
    [token],
    'org-system'
  );
}

// Resolve a referral code back to the share that minted it. NO owner_key: the
// caller is the signup webhook, which knows only the opaque code the visitor
// carried in from the share page. This is the one place the code becomes an
// account again, and it happens server-side, never in a response body.
async function getShareTokenByRefCode(refCode) {
  await ensureSchema();
  const result = await db.query(
    'SELECT * FROM context_share_tokens WHERE ref_code = $1',
    [refCode],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

// The durable half of conversion measurement. PostHog carries the same fact as a
// property on account_created, but this table is the system of record that
// survives an analytics outage, a filter mistake, or a retention window — three
// things that have each already cost this funnel a wrong reading.
async function recordShareTokenConversion(refCode) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE context_share_tokens SET conversion_count = conversion_count + 1
      WHERE ref_code = $1
      RETURNING *`,
    [refCode],
    'org-system'
  );
  return rowToShareToken(result.rows[0]);
}

module.exports = {
  redactForStorage,
  saveTaskReview,
  getTaskReview,
  deleteTaskReview,
  // Exported so boot-time migration can create the context_* tables before altering them
  // (see config/autoMigrate.js). Idempotent and memoised via schemaReadyPromise.
  ensureSchema,
  runTransportBackfill,
  TRANSPORT_BACKFILL_LOCK_KEY,
  listSameEntityNodesInOtherProjects,
  getProject,
  getProjectContextOnly,
  getProjectUpdatedAt,
  listProjects,
  getSubprojects,
  setProjectArchived,
  listProjectsInactiveSince,
  listArchivedProjects,
  getWorkspacePointer,
  setWorkspacePointer,
  listProjectIdentifiers,
  listVisibleProjectIds,
  workspaceMayHoldOthersWork,
  listGraphNodeProjectIds,
  listProjectShareScopes,
  listProjectReaders,
  listProjectCandidates,
  listLinkedPathClaims,
  stampWorkspaceKeyIfMissing,
  getLatestSessionProject,
  getLatestSessionBinding,
  hasOwnWorkInWorkspaces,
  getSessionBinding,
  getSessionBindingState,
  saveBindingNotice,
  takeBindingNotices,
  bindSession,
  countTopLevelProjects,
  listProjectNames,
  saveProject,
  renameProject,
  deleteProject,
  appendEvent,
  getProjectShare,
  getProjectShares,
  upsertProjectShare,
  getGlobal,
  getGlobalReviewState,
  markGlobalReviewed,
  saveGlobal,
  globalFounderId,
  claimLegacyGlobals,
  getSession,
  listSessions,
  listPeerSessions,
  touchSession,
  listRecentNodesBySessions,
  saveSession,
  upsertGraphNode,
  recordGraphNodeSelections,
  upsertGraphEdge,
  ensurePrivateToIndex,
  addGraphEvidence,
  listGraphNodesForProject,
  listGraphEdgesForProject,
  listGraphEvidenceForProject,
  getGraphNode,
  getGraphNodeByCanonicalKey,
  listGraphNodesByKeyPrefix,
  recordProjectAffinity,
  listProjectAffinities,
  listProjectContributors,
  recordSessionLoad,
  getSessionLoadStats,
  listGraphNodes,
  listGraphNodesByIds,
  listGraphEdgesForNode,
  listGraphEvidenceForNode,
  listRecentGraphFacts,
  listAllGraphData,
  upsertGraphEmbedding,
  getGraphEmbeddings,
  getPreferences,
  savePreferences,
  clearAll,
  deleteGraphNode,
  upsertWorkspaceSkill,
  listWorkspaceSkills,
  getWorkspaceSkill,
  deleteWorkspaceSkill,
  listCrossProjectEntities,
  listWorkspaceScopedEntities,
  createShareToken,
  getShareTokenByToken,
  getShareTokenByRefCode,
  recordShareTokenConversion,
  listShareTokens,
  setShareTokenVisibility,
  revokeShareToken,
  recordShareTokenView,
};

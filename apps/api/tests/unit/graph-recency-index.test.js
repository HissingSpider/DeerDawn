process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * listRecentGraphFacts sorted every graph row the owner had, on every brief.
 *
 * The three graph indexes lead (owner_key, project_id, <time>). These queries
 * filter on owner_key ALONE and order by the time column, so project_id sits
 * between the equality column and the sort key: Postgres can find the owner's
 * rows but cannot take the ordering from the index, and falls back to reading
 * all of them and sorting. getProjectGraph calls this, and getSessionGraph calls
 * it again, so one session-bound start_session paid six owner-wide sorts whose
 * cost scaled with the account's total graph rather than the 40 rows requested.
 *
 * This asserts the PLAN, not a wall-clock time — a timing assertion on a small
 * dev database would pass while the production shape stayed quadratic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');

const OWNER = 'org-system';

test('owner-wide graph recency reads are served by an index, not a sort', async (t) => {
  if (!await ensureDatabaseAvailable(t, db, 'graph recency index')) return;
  // Touch the store so ensureSchema() creates the indexes.
  await store.listRecentGraphFacts(OWNER, 5).catch(() => ({}));

  const cases = [
    ['context_graph_nodes', 'last_seen_at', 'idx_context_graph_nodes_owner_seen'],
    ['context_graph_edges', 'last_seen_at', 'idx_context_graph_edges_owner_seen'],
    ['context_graph_evidence', 'created_at', 'idx_context_graph_evidence_owner_created'],
  ];

  for (const [table, timeCol, expectedIndex] of cases) {
    const present = await db.query(
      'SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexname = $2',
      [table, expectedIndex],
      OWNER
    );
    assert.equal(
      present.rows.length,
      1,
      `${expectedIndex} is missing — an owner-wide ORDER BY ${timeCol} on ${table} falls back to a full sort`
    );

    // The index must be usable as the ordering source: owner_key first, then the
    // time column, with nothing in between.
    const cols = await db.query(
      `SELECT a.attname, k.ord
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = $1
        ORDER BY k.ord`,
      [expectedIndex],
      OWNER
    );
    const names = cols.rows.map((r) => r.attname);
    assert.deepEqual(
      names,
      ['owner_key', timeCol],
      `${expectedIndex} must be exactly (owner_key, ${timeCol}); a column in between makes it useless for this ORDER BY`
    );
  }
});

test.after(async () => {
  await db.pool?.end?.().catch(() => {});
});

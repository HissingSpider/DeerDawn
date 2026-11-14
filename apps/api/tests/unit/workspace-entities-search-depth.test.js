/**
 * recall entities / mark_resolved must find entities older than the recency window.
 *
 * getWorkspaceEntities fetched the newest max(limit * 3, 20) nodes by
 * last_seen_at and applied the text query IN MEMORY. Anything older than that
 * window was "No entity found" to recall, and mark_resolved (which searches with
 * limit 5, so a window of 20) could never resolve it — the older and more
 * settled a decision, the less reachable it became.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/workspace-entities-search-depth.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { closeRedisConnections } = require('../../src/config/redis');

const OWNER = 'org-entity-depth-0000-4000-8000-000000000001';
const ACTOR = { org_id: OWNER, id: 'user-entity-depth' };

async function clearOwner() {
  await db.query('DELETE FROM context_graph_nodes WHERE owner_key = $1', [OWNER], 'org-system').catch(() => {});
}

test('a text query reaches entities outside the newest-N recency window', async (t) => {
  if (!await ensureDatabaseAvailable(t, db, 'workspace entity search depth')) return;
  await store.listGraphNodes(OWNER, { limit: 1 });
  await clearOwner();

  await service.upsertWorkspaceEntities(ACTOR, {
    entities: [{
      entity_type: 'decision',
      title: 'Quokka retry budget stays at three attempts',
      summary: 'Retries on the ingest worker are capped at three so a poisoned message cannot pin a machine.',
    }],
  });
  // Age the target well behind everything written after it.
  await db.query(
    'UPDATE context_graph_nodes SET last_seen_at = NOW() - INTERVAL \'400 days\', updated_at = NOW() - INTERVAL \'400 days\' WHERE owner_key = $1',
    [OWNER],
    'org-system'
  );

  const fillers = Array.from({ length: 60 }, (_, i) => ({
    entity_type: 'decision',
    title: `Filler decision number ${i + 1} about module ${i + 1}`,
    summary: `Module ${i + 1} keeps its own connection pool sized for its measured peak load.`,
  }));
  for (let i = 0; i < fillers.length; i += 20) {
    await service.upsertWorkspaceEntities(ACTOR, { entities: fillers.slice(i, i + 20) });
  }

  const newest = await store.listGraphNodes(OWNER, { limit: 30 });
  assert.ok(
    !newest.some((node) => /quokka/i.test(node.title)),
    'fixture precondition: the target must sit outside the newest-30 window'
  );

  const recalled = await service.getWorkspaceEntities(ACTOR, { query: 'quokka', limit: 10, track_selection: false });
  assert.ok(recalled.some((node) => /quokka/i.test(node.title)), 'recall entities finds the older entity');

  // mark_resolved's exact call shape: limit 5, include_resolved.
  const candidates = await service.getWorkspaceEntities(ACTOR, {
    query: 'Quokka retry budget stays at three attempts',
    include_resolved: true,
    limit: 5,
    track_selection: false,
  });
  assert.ok(candidates.some((node) => /quokka/i.test(node.title)), 'mark_resolved can find the older entity');

  // LIKE metacharacters in a query are literal, not wildcards.
  const wildcard = await store.listGraphNodes(OWNER, { textTerms: ['%%%'], limit: 100 });
  assert.equal(wildcard.length, 0, 'a % in the query must not match every node');
});

test.after(async () => {
  try { await clearOwner(); } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

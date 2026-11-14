/**
 * Compounding intelligence — retrieval reinforcement.
 *
 * Every delivered injection reinforces the graph nodes it surfaced, so ranking
 * learns from real use and candidates promote to durable. This is the loop that
 * makes the graph personalize and compound over sessions (and become hard to
 * recreate elsewhere — the switching-cost moat).
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-compounding.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

test('retrieval reinforcement compounds hits and promotes candidate→durable', async () => {
  await store.clearAll();

  const created = await service.upsertWorkspaceEntities(actor(), {
    entities: [{
      entity_type: 'knowledge',
      title: 'Compounding Reinforcement Node',
      summary: 'A distinct durable note used to verify retrieval reinforcement across repeated sessions.',
      metadata: { memory_tier: 'candidate', seen_count: 1, source_count: 1, retrieval_hits: 0 },
    }],
  });
  const node0 = created.entities[0];
  assert.equal(node0.metadata.memory_tier, 'candidate', 'starts as a candidate');
  assert.equal(Number(node0.metadata.retrieval_hits || 0), 0, 'starts with no retrieval hits');

  const ownerKey = 'org-system';
  const { node_type: type, canonical_key: key } = node0;

  // Each retrieval re-reads current DB state, exactly as a fresh session does.
  const r1 = await store.getGraphNodeByCanonicalKey(ownerKey, type, key);
  await service.trackWorkspaceSelections(actor(), [r1]);
  const afterFirst = await store.getGraphNodeByCanonicalKey(ownerKey, type, key);
  assert.equal(Number(afterFirst.metadata.retrieval_hits), 1, 'first retrieval increments hits');
  assert.equal(afterFirst.metadata.memory_tier, 'candidate', 'one hit is not yet enough to promote');

  await service.trackWorkspaceSelections(actor(), [afterFirst]);
  const afterSecond = await store.getGraphNodeByCanonicalKey(ownerKey, type, key);
  assert.equal(Number(afterSecond.metadata.retrieval_hits), 2, 'second retrieval increments again');
  assert.equal(afterSecond.metadata.memory_tier, 'durable', 'two retrievals promote candidate→durable');
});

test('reinforcement is idempotent within a single selection batch', async () => {
  await store.clearAll();
  const created = await service.upsertWorkspaceEntities(actor(), {
    entities: [{
      entity_type: 'knowledge',
      title: 'Single Batch Node',
      summary: 'A node passed twice in one batch must only be reinforced once.',
      metadata: { memory_tier: 'candidate', seen_count: 1, source_count: 1, retrieval_hits: 0 },
    }],
  });
  const node = created.entities[0];
  await service.trackWorkspaceSelections(actor(), [node, node]); // duplicate in same batch
  const after = await store.getGraphNodeByCanonicalKey('org-system', node.node_type, node.canonical_key);
  assert.equal(Number(after.metadata.retrieval_hits), 1, 'duplicates in one batch count once');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

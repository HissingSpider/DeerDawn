/**
 * A batch of workspace entities succeeds or skips ONE ENTITY AT A TIME.
 *
 * upsertWorkspaceEntities writes each entity inside its loop and threw on the
 * first one it disliked. So a batch of [good, bad, good] stored the first,
 * answered with an error, and never reached the third: the caller was told the
 * batch failed, a third of it had landed, and a retry re-sent all of it. Now each
 * entity is written or skipped on its own and the skips come back with a reason.
 * A call where NOTHING could be written still throws what it always threw.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/workspace-entities-batch-skip.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const service = require('../../src/services/contextSyncService');
const { closeRedisConnections } = require('../../src/config/redis');

const ORG = `org-${uuidv4()}`;
const actor = { org_id: ORG, id: `user-batch-${uuidv4().slice(0, 8)}` };
const RUN = uuidv4().slice(0, 8);

test.after(async () => {
  for (const table of ['context_graph_edges', 'context_graph_evidence', 'context_graph_embeddings', 'context_graph_nodes']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [ORG], 'org-system').catch(() => {});
  }
  await closeRedisConnections().catch(() => {});
});

async function storedTitles() {
  const result = await db.query('SELECT title FROM context_graph_nodes WHERE owner_key = $1', [ORG], 'org-system');
  return result.rows.map((row) => row.title).sort();
}

test('a bad entity in the middle is skipped and reported; the ones around it are stored', async () => {
  const first = `Postgres advisory locks guard the scheduler ${RUN}`;
  const third = `Fly machines restart on a failed health check ${RUN}`;
  const result = await service.upsertWorkspaceEntities(actor, {
    entities: [
      { title: first, entity_type: 'decision', summary: 'Chosen over Redis locks because the scheduler already holds a DB connection.' },
      { title: 'x', entity_type: 'decision' },
      { title: third, entity_type: 'knowledge', summary: 'The grace period is ninety seconds, set in fly.toml.' },
    ],
    relations: [],
  });

  assert.deepStrictEqual(result.entities.map((node) => node.title).sort(), [first, third].sort());
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].reason, 'workspace_entity_title_required');
  assert.deepStrictEqual(
    await storedTitles(),
    [first, third].sort(),
    'THE BUG: the batch threw on the second entity, so the first was stored, the third never was, and the caller was told it all failed',
  );
});

test('a call where nothing could be written still throws the error it always did', async () => {
  await assert.rejects(
    () => service.upsertWorkspaceEntities(actor, { entities: [{ title: 'x', entity_type: 'decision' }], relations: [] }),
    (err) => err.message === 'workspace_entity_title_required' && /at least 3 characters/.test(err.publicMessage),
  );
  await assert.rejects(
    () => service.upsertWorkspaceEntities(actor, { entities: [{ title: `A real title ${RUN}`, entity_type: 'not-a-type' }], relations: [] }),
    (err) => err.message === 'workspace_entity_type_invalid',
  );
});

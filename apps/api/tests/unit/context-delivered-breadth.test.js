/**
 * context_delivered must carry BREADTH.
 *
 * The strategic bet behind this product is that breadth is what makes it worth
 * paying for: "one project genuinely does not need this; four or more concurrent
 * projects does". Before these fields existed, nothing emitted by the product
 * could test that sentence — context_delivered carried project_id, tool and a
 * token count, so a brief delivered into a one-project account and a brief
 * delivered into a twelve-project account were indistinguishable in the data.
 *
 * These tests exist so that stays answerable. Specifically they pin:
 *   1. Both breadth fields ride on a delivered brief, with real values.
 *   2. "Project count" means CONCURRENT top-level projects — subprojects are
 *      workstreams of one workspace and must not inflate it.
 *   3. related_project_count is derived from the graph's related_project_ids
 *      (the array the affinity write already consumes) and is de-duplicated.
 *   4. BOTH context_delivered emitters carry the SAME keys. A breadth field on
 *      only one of them would be worse than no field: the no-project path is
 *      exactly where the low-breadth accounts are, so a missing field there
 *      biases the sample toward users who already have a working project.
 *   5. A FAILED count reports null, never 0. 0 is a real, meaningful value here,
 *      so a failed read collapsing into it would manufacture precisely the
 *      single-project users this metric exists to distinguish.
 */
const test = require('node:test');
const assert = require('node:assert');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const graphService = require('../../src/services/contextGraphService');
const productEvents = require('../../src/services/productEventsService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');

// org_id must be org-<uuid> (db.js ORG_ID_PATTERN); a fixed value keeps reruns idempotent.
const ORG = 'org-cccccccc-3333-4333-8333-cccccccccc33';
const actor = () => ({ org_id: ORG, id: 'user-breadth' });

// The emit is deliberately fire-and-forget (setImmediate + a COUNT) so it never
// buys latency on /active — which means the assertion has to wait for it rather
// than read it synchronously.
async function waitForEvent(captured, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = captured.find((e) => e.event_name === name);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${name}; saw: ${captured.map((e) => e.event_name).join(', ') || '(none)'}`);
}

function captureEvents() {
  const captured = [];
  const original = productEvents.recordProductEvent;
  productEvents.recordProductEvent = async (a, input) => {
    captured.push(input);
    return input;
  };
  return {
    captured,
    restore() { productEvents.recordProductEvent = original; },
  };
}

test('context_delivered carries the breadth fields that make the ICP question answerable', async (t) => {
  await ensureRuntimeSchema();
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
  await db.query('DELETE FROM organizations WHERE org_id = $1', [ORG], ORG);
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $3, $4)',
    [ORG, 'Breadth Co', 'free', 'active'],
    ORG
  );

  // Four concurrent projects: the exact side of the ICP line the bet is about.
  const one = await service.createProject(actor(), { project_name: 'Breadth One' });
  const two = await service.createProject(actor(), { project_name: 'Breadth Two' });
  const three = await service.createProject(actor(), { project_name: 'Breadth Three' });
  await service.createProject(actor(), { project_name: 'Breadth Four' });
  // A subproject is a workstream of an existing workspace, not a fifth project.
  await service.createProject(actor(), {
    project_name: 'Breadth One Substream',
    parent_project_id: one.project_id,
  });

  await t.test('a delivered project brief reports the workspace size', async () => {
    const cap = captureEvents();
    try {
      const payload = await service.renderInjection(actor(), one.project_id, 'cursor', 'detailed');
      assert.ok(payload, 'expected an injection payload');
      const event = await waitForEvent(cap.captured, 'context_delivered');

      assert.strictEqual(
        event.metadata.workspace_project_count, 4,
        'four top-level projects — the subproject must NOT inflate the count, ' +
        'because a workstream of one workspace is not a concurrent project',
      );
      assert.strictEqual(event.metadata.related_project_count, 0, 'nothing related on a fresh graph');
      assert.strictEqual(event.metadata.project_id, one.project_id);
      assert.strictEqual(event.metadata.scope, 'project');
    } finally {
      cap.restore();
    }
  });

  await t.test('related_project_count comes from the graph ids, de-duplicated', async () => {
    // The same array recordProjectAffinities consumes a few lines earlier —
    // reused, not recomputed. Duplicates are real: a project can be reached
    // through more than one node.
    const originalGraph = graphService.getProjectGraph;
    graphService.getProjectGraph = async () => ({
      nodes: [],
      edges: [],
      // Real ids: the same array also reaches recordProjectAffinities, which
      // has a foreign key on them. Fake ids would still pass this assertion
      // while filling the log with FK failures from the affinity write.
      related_project_ids: [two.project_id, three.project_id, two.project_id],
    });
    const cap = captureEvents();
    try {
      await service.renderInjection(actor(), one.project_id, 'codex', 'detailed');
      const event = await waitForEvent(cap.captured, 'context_delivered');
      assert.strictEqual(event.metadata.related_project_count, 2, 'two distinct related projects, not three ids');
      assert.strictEqual(event.metadata.workspace_project_count, 4);
    } finally {
      cap.restore();
      graphService.getProjectGraph = originalGraph;
    }
  });

  await t.test('the global-only emitter carries the SAME keys', async () => {
    // Shape parity is the whole point. A field only the project path carries
    // makes the measurable population a biased subset of the real one.
    await service.updateGlobalContext(actor(), { user_profile: 'Ships analytics that do not lie.' });
    const cap = captureEvents();
    try {
      const payload = await service.renderInjection(actor(), null, 'cursor', 'detailed');
      assert.ok(payload, 'expected a global-only payload');
      const event = await waitForEvent(cap.captured, 'context_delivered');

      assert.strictEqual(event.metadata.scope, 'global');
      assert.strictEqual(event.metadata.project_id, null);
      assert.strictEqual(event.metadata.workspace_project_count, 4, 'workspace size is known even with no project resolved');
      assert.strictEqual(event.metadata.related_project_count, 0, 'a true zero: no project brief, so nothing was surfaced into one');

      for (const key of ['workspace_project_count', 'related_project_count', 'scope', 'tool', 'approximate_tokens']) {
        assert.ok(key in event.metadata, `global emitter must carry ${key} like the project emitter does`);
      }
    } finally {
      cap.restore();
    }
  });

  await t.test('a failed count reports null, never 0', async () => {
    // 0 is a REAL value here (a brief delivered to an account with no projects).
    // If a failed read collapsed into it, a database hiccup would look exactly
    // like the single-project users this metric exists to count — the metric
    // would fail toward the answer, which is the worst possible failure mode.
    const originalCount = store.countTopLevelProjects;
    store.countTopLevelProjects = async () => { throw new Error('db down'); };
    const cap = captureEvents();
    try {
      await service.renderInjection(actor(), one.project_id, 'claude_code', 'detailed');
      const event = await waitForEvent(cap.captured, 'context_delivered');
      assert.strictEqual(event.metadata.workspace_project_count, null, 'unknown must be null, not 0');
      assert.strictEqual(event.metadata.related_project_count, 0, 'the graph-derived half still reports');
    } finally {
      cap.restore();
      store.countTopLevelProjects = originalCount;
    }
  });

  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
  await db.query('DELETE FROM organizations WHERE org_id = $1', [ORG], ORG);
  await closeRedisConnections();
  await db.pool.end();
});

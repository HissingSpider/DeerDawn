/**
 * Backfill orchestration — verifies scripts/backfill-subprojects.js re-parents the
 * existing rows, renames them, creates the one new subproject, and is idempotent.
 * Runs against seeded local rows (never production).
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/backfill-subprojects.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const backfill = require('../../scripts/backfill-subprojects');
const { closeRedisConnections } = require('../../src/config/redis');

const OWNER = 'org-system';
function actor() { return { org_id: 'org-system', id: 'system-key' }; }

async function seed(projectId, name) {
  const now = new Date().toISOString();
  await store.saveProject({
    project_id: projectId,
    owner_key: OWNER,
    project_name: name,
    context: { description: 'seed' },
    created_at: now,
    updated_at: now,
  });
}

async function seedPlan() {
  const { DEFAULT_PARENT, CHILDREN } = backfill.PLAN;
  await seed(DEFAULT_PARENT, 'DeerDawn');
  for (const c of CHILDREN) await seed(c.id, `old ${c.id}`);
}

test('backfill nests the children under the umbrella, renames them, and creates Platform & Release', async () => {
  await store.clearAll();
  const { DEFAULT_PARENT, CHILDREN, NEW_SUBPROJECTS } = backfill.PLAN;
  await seedPlan();

  await backfill({ apply: true, parent: DEFAULT_PARENT });

  const tree = await service.listProjectTree(actor());
  const umbrella = tree.find((p) => p.project_id === DEFAULT_PARENT);
  assert.ok(umbrella, 'umbrella is a root');

  const subIds = umbrella.subprojects.map((s) => s.project_id);
  for (const c of CHILDREN) assert.ok(subIds.includes(c.id), `${c.id} is nested`);

  const names = umbrella.subprojects.map((s) => s.project_name);
  for (const c of CHILDREN) if (c.name) assert.ok(names.includes(c.name), `renamed to ${c.name}`);
  for (const s of NEW_SUBPROJECTS) assert.ok(names.includes(s.name), `created ${s.name}`);

  const rootIds = tree.map((p) => p.project_id);
  for (const c of CHILDREN) assert.ok(!rootIds.includes(c.id), `${c.id} is not a root`);
});

test('backfill dry run changes nothing', async () => {
  await store.clearAll();
  const { DEFAULT_PARENT, CHILDREN } = backfill.PLAN;
  await seedPlan();

  await backfill({ apply: false, parent: DEFAULT_PARENT });

  // Every child is still a top-level root; nothing was re-parented or created.
  const tree = await service.listProjectTree(actor());
  const rootIds = tree.map((p) => p.project_id);
  for (const c of CHILDREN) assert.ok(rootIds.includes(c.id), 'still a root after dry run');
  const umbrella = tree.find((p) => p.project_id === DEFAULT_PARENT);
  assert.equal(umbrella.subprojects.length, 0, 'no subprojects created in dry run');
});

test('backfill is idempotent — a second apply makes no duplicates', async () => {
  await store.clearAll();
  const { DEFAULT_PARENT, CHILDREN, NEW_SUBPROJECTS } = backfill.PLAN;
  await seedPlan();

  await backfill({ apply: true, parent: DEFAULT_PARENT });
  await backfill({ apply: true, parent: DEFAULT_PARENT });

  const tree = await service.listProjectTree(actor());
  const umbrella = tree.find((p) => p.project_id === DEFAULT_PARENT);
  assert.equal(
    umbrella.subprojects.length,
    CHILDREN.length + NEW_SUBPROJECTS.length,
    'no duplicate subprojects on re-run',
  );
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

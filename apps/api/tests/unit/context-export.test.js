/**
 * Context export — the custody-lock-in pressure valve.
 *
 * "You can always get your data out": exportContext must return a portable bundle
 * with the owner's global profile, preferences, and every project + its context.
 * It must NOT depend on the compounding layer (affinities/rankings/embeddings),
 * which is recomputed, not a stored artifact — so the export reassures without
 * carrying the moat.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-export.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

test('exportContext returns a portable bundle of profile + projects + context', async () => {
  await store.clearAll();

  await service.updateGlobalContext(actor(), {
    user_profile: 'Solo founder building DeerDawn',
    expertise_areas: ['distributed systems', 'billing'],
  });

  const project = await service.createProject(actor(), {
    project_name: 'Export Target',
    description: 'A project to export',
    goals: [],
    current_status: 'building',
  });
  await service.updateProjectContext(actor(), project.project_id, { current_task: 'Ship the export route' });

  const bundle = await service.exportContext(actor());

  assert.equal(bundle.schema_version, 1, 'versioned for forward compatibility');
  assert.ok(bundle.exported_at, 'stamped with an export time');
  assert.match(bundle.global_context.user_profile, /Solo founder/, 'carries the global profile');
  assert.ok(bundle.global_context.expertise_areas.includes('billing'), 'carries structured profile fields');

  const exported = bundle.projects.find((p) => p.project_id === project.project_id);
  assert.ok(exported, 'the project is present in the export');
  assert.equal(exported.project_name, 'Export Target');
  assert.equal(exported.context.current_task, 'Ship the export route', 'carries project context');
  assert.ok(Array.isArray(exported.graph.nodes), 'graph nodes travel as an array');
  assert.ok(Array.isArray(exported.linked_paths), 'linked paths travel as an array');
});

test('exportContext on an empty workspace is a valid, empty bundle', async () => {
  await store.clearAll();
  const bundle = await service.exportContext(actor());
  assert.equal(bundle.schema_version, 1);
  assert.deepEqual(bundle.projects, [], 'no projects → empty list, not an error');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

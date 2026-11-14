/**
 * Subprojects — a subproject is a normal project row with parent_project_id set.
 * These cover the invariants the service enforces (the DB column deliberately
 * does not): same owner, exactly one level deep, no cycles, and the portfolio
 * tree assembly.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-subprojects.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.message, code, `expected error "${code}", got "${err.message}"`);
    return true;
  });
}

test('createProject nests a child under a valid parent', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const child = await service.createProject(actor(), {
    project_name: 'Child A',
    parent_project_id: parent.project_id,
  });
  assert.equal(child.parent_project_id, parent.project_id);

  const kids = await store.getSubprojects('org-system', parent.project_id, { system: true });
  assert.deepEqual(kids.map((k) => k.project_id), [child.project_id]);
});

test('createProject rejects an unknown parent', async () => {
  await store.clearAll();
  await rejects(
    service.createProject(actor(), { project_name: 'Orphan', parent_project_id: 'project_nope' }),
    'parent_project_not_found',
  );
});

test('createProject rejects nesting under a subproject (one level deep)', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const child = await service.createProject(actor(), {
    project_name: 'Child',
    parent_project_id: parent.project_id,
  });
  await rejects(
    service.createProject(actor(), { project_name: 'Grandchild', parent_project_id: child.project_id }),
    'subproject_depth_exceeded',
  );
});

test('setProjectParent attaches, then promotes back to top-level', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const loose = await service.createProject(actor(), { project_name: 'Loose' });

  await service.setProjectParent(actor(), loose.project_id, parent.project_id);
  assert.equal((await store.getProject('org-system', loose.project_id)).parent_project_id, parent.project_id);

  await service.setProjectParent(actor(), loose.project_id, null);
  assert.equal((await store.getProject('org-system', loose.project_id)).parent_project_id, null);
});

test('setProjectParent rejects self-parenting and depth violations', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const child = await service.createProject(actor(), {
    project_name: 'Child',
    parent_project_id: parent.project_id,
  });
  const other = await service.createProject(actor(), { project_name: 'Other' });

  await rejects(service.setProjectParent(actor(), other.project_id, other.project_id), 'project_cannot_parent_itself');
  // Attaching under a project that is itself a child would create a 2nd level.
  await rejects(service.setProjectParent(actor(), other.project_id, child.project_id), 'subproject_depth_exceeded');
});

test('setProjectParent rejects re-parenting a project that has children', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  await service.createProject(actor(), { project_name: 'Child', parent_project_id: parent.project_id });
  const wouldBeGrandparent = await service.createProject(actor(), { project_name: 'Higher' });

  // Moving `parent` (which has a child) under another project would push its
  // child to a third level — rejected.
  await rejects(
    service.setProjectParent(actor(), parent.project_id, wouldBeGrandparent.project_id),
    'project_has_subprojects',
  );
});

test('listProjectTree nests children and surfaces orphans as roots', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const childA = await service.createProject(actor(), { project_name: 'Child A', parent_project_id: parent.project_id });
  const childB = await service.createProject(actor(), { project_name: 'Child B', parent_project_id: parent.project_id });
  const standalone = await service.createProject(actor(), { project_name: 'Standalone' });

  const tree = await service.listProjectTree(actor());
  const umbrella = tree.find((p) => p.project_id === parent.project_id);
  assert.ok(umbrella, 'umbrella is a root');
  assert.deepEqual(
    umbrella.subprojects.map((s) => s.project_id).sort(),
    [childA.project_id, childB.project_id].sort(),
  );
  assert.ok(tree.some((p) => p.project_id === standalone.project_id), 'standalone is its own root');
  // Children must NOT appear as top-level roots.
  assert.ok(!tree.some((p) => p.project_id === childA.project_id));
});

// --- Active-subproject resolution (Phase 5) ---

const { v4: uuidv4 } = require('uuid');

function savedProject(overrides = {}) {
  const id = `proj-${uuidv4()}`;
  const now = new Date().toISOString();
  return store.saveProject({
    project_id: id,
    owner_key: 'org-system',
    project_name: `P ${id}`,
    context: { description: 'x' },
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

test('switchSubproject pins a subproject; resolveActiveProject honors it over recency', async () => {
  await store.clearAll();
  const ws = 'remote:github.com/acme/repo';
  const parent = `proj-${uuidv4()}`;
  const childA = `proj-${uuidv4()}`;
  const childB = `proj-${uuidv4()}`;
  await savedProject({ project_id: parent, project_name: 'Umbrella', workspace_key: ws, updated_at: '2026-01-01T00:00:00.000Z' });
  await savedProject({ project_id: childA, project_name: 'Marketing', workspace_key: ws, parent_project_id: parent, updated_at: '2026-01-02T00:00:00.000Z' });
  // childB is the most-recently-updated, so it wins the recency tiebreak by default.
  await savedProject({ project_id: childB, project_name: 'Platform', workspace_key: ws, parent_project_id: parent, updated_at: '2026-06-01T00:00:00.000Z' });

  const beforePin = await service.resolveActiveProject(actor(), null, ws);
  assert.equal(beforePin.project_id, childB, 'recency winner before any pin');

  await service.switchSubproject(actor(), childA, ws);
  const afterPin = await service.resolveActiveProject(actor(), null, ws);
  assert.equal(afterPin.project_id, childA, 'pin wins over recency');
  assert.equal(afterPin.match_kind, 'pinned');
});

test('a pin is workspace-scoped and cannot hijack a different codebase', async () => {
  await store.clearAll();
  const wsA = 'remote:github.com/acme/a';
  const wsB = 'remote:github.com/acme/b';
  const pinned = `proj-${uuidv4()}`;
  const otherRepo = `proj-${uuidv4()}`;
  await savedProject({ project_id: pinned, project_name: 'A-child', workspace_key: wsA, updated_at: '2026-01-02T00:00:00.000Z' });
  await savedProject({ project_id: otherRepo, project_name: 'B-only', workspace_key: wsB, updated_at: '2026-01-01T00:00:00.000Z' });

  await service.switchSubproject(actor(), pinned, wsA);
  // Resolving in workspace B must NOT return the pin from workspace A.
  const inB = await service.resolveActiveProject(actor(), null, wsB);
  assert.equal(inB.project_id, otherRepo);
  assert.notEqual(inB.match_kind, 'pinned');
});

test('a stale pin (deleted project) is ignored, not fatal', async () => {
  await store.clearAll();
  const ws = 'remote:github.com/acme/stale';
  const live = `proj-${uuidv4()}`;
  await savedProject({ project_id: live, project_name: 'Live', workspace_key: ws, updated_at: '2026-01-01T00:00:00.000Z' });
  // Pin points at a project id that doesn't exist as a candidate.
  await store.setWorkspacePointer('org-system', ws, `proj-${uuidv4()}`);

  const resolved = await service.resolveActiveProject(actor(), null, ws);
  assert.equal(resolved.project_id, live, 'falls through to normal scoring');
});

test('switchSubproject requires a workspace_key and an existing project', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Solo Project' });
  await rejects(service.switchSubproject(actor(), p.project_id, ''), 'workspace_key_required');
  await rejects(service.switchSubproject(actor(), 'project_missing', 'remote:x'), 'project_not_found');
});

// --- Archive (Phase 7) ---

test('archiveProject hides a project from the list and restores on unarchive', async () => {
  await store.clearAll();
  const keep = await service.createProject(actor(), { project_name: 'Keep' });
  const dead = await service.createProject(actor(), { project_name: 'Dead' });

  await service.archiveProject(actor(), dead.project_id);
  let ids = (await service.listProjects(actor())).map((p) => p.project_id);
  assert.ok(ids.includes(keep.project_id));
  assert.ok(!ids.includes(dead.project_id), 'archived project is hidden');
  // Still retrievable when explicitly including archived.
  ids = (await service.listProjects(actor(), { includeArchived: true })).map((p) => p.project_id);
  assert.ok(ids.includes(dead.project_id));

  await service.unarchiveProject(actor(), dead.project_id);
  ids = (await service.listProjects(actor())).map((p) => p.project_id);
  assert.ok(ids.includes(dead.project_id), 'unarchive restores it');
});

test('an archived project never auto-resolves as active', async () => {
  await store.clearAll();
  const ws = 'remote:github.com/acme/arch';
  const live = `proj-${uuidv4()}`;
  const dead = `proj-${uuidv4()}`;
  await savedProject({ project_id: live, project_name: 'Live', workspace_key: ws, updated_at: '2026-01-01T00:00:00.000Z' });
  await savedProject({ project_id: dead, project_name: 'Dead', workspace_key: ws, updated_at: '2026-06-01T00:00:00.000Z' });

  // `dead` is most-recent, so it would win — until archived.
  await service.archiveProject(actor(), dead);
  const resolved = await service.resolveActiveProject(actor(), null, ws);
  assert.equal(resolved.project_id, live);
});

test('archiveProject refuses an umbrella with live children', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  await service.createProject(actor(), { project_name: 'Child', parent_project_id: parent.project_id });
  await rejects(service.archiveProject(actor(), parent.project_id), 'archive_parent_with_children');
});

test('archived children drop out of the project tree', async () => {
  await store.clearAll();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const a = await service.createProject(actor(), { project_name: 'Child A', parent_project_id: parent.project_id });
  const b = await service.createProject(actor(), { project_name: 'Child B', parent_project_id: parent.project_id });

  await service.archiveProject(actor(), b.project_id);
  const tree = await service.listProjectTree(actor());
  const umbrella = tree.find((p) => p.project_id === parent.project_id);
  assert.deepEqual(umbrella.subprojects.map((s) => s.project_id), [a.project_id]);
});

// --- Rename ---

test('renameProject changes the name and rejects junk', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Old Name' });

  const renamed = await service.renameProject(actor(), p.project_id, 'New Name');
  assert.equal(renamed.project_name, 'New Name');
  assert.equal((await store.getProject('org-system', p.project_id)).project_name, 'New Name');

  // A junk name (a path here) is refused, not coerced to "Untitled project".
  await rejects(service.renameProject(actor(), p.project_id, 'apps/api/foo.js'), 'invalid_project_name');
  // The rejected rename left the existing name intact.
  assert.equal((await store.getProject('org-system', p.project_id)).project_name, 'New Name');
});

test('renameProject rejects an over-limit name instead of silently truncating it', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Old Name' });
  const longName = 'A very long project name that keeps going '.repeat(4).trim();
  assert.ok(longName.length > 120, 'fixture name must exceed the limit to exercise the check');

  await rejects(service.renameProject(actor(), p.project_id, longName), 'project_name_too_long');
  // The rejected rename left the existing name intact — no silent mid-word truncation.
  assert.equal((await store.getProject('org-system', p.project_id)).project_name, 'Old Name');
});

test('renameProject rejects an unknown project', async () => {
  await store.clearAll();
  await rejects(service.renameProject(actor(), 'project_missing', 'Whatever'), 'project_not_found');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

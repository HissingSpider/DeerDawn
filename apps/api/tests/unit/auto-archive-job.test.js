/**
 * Auto-archive job — soft-archives projects idle past the cutoff so a stale
 * dashboard cleans itself up. The invariants that matter are that it is
 * non-destructive (context survives), reversible (unarchive restores and grants
 * a fresh window), and that it never hides an umbrella out from under live
 * children.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/auto-archive-job.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { runAutoArchive, isEnabled, inactiveDays, DEFAULT_INACTIVE_DAYS } = require('../../src/jobs/autoArchiveJob');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { formatArchivedProjectsNotice } = require('../../../../packages/shared-context/src/index.js');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

// store.clearAll() is scoped to owner_key = 'org-system', but this job sweeps
// EVERY owner — so rows another suite left behind would otherwise land in our
// counts. Reset globally to match the job's scope.
async function resetProjects() {
  await store.clearAll();
  await db.query('DELETE FROM context_events', [], 'org-system');
  await db.query('DELETE FROM context_projects', [], 'org-system');
}

// Backdate updated_at directly — the service always stamps NOW(), so there is
// no supported way to author an "old" project through the public API.
async function backdate(projectId, days) {
  await db.query(
    `UPDATE context_projects SET updated_at = NOW() - INTERVAL '${Number(days)} days' WHERE project_id = $1`,
    [projectId],
    'org-system'
  );
}

async function archivedAt(projectId) {
  const { rows } = await db.query(
    'SELECT archived_at FROM context_projects WHERE project_id = $1',
    [projectId],
    'org-system'
  );
  return rows[0]?.archived_at || null;
}

test('archives a project idle past the cutoff and leaves a fresh one alone', async () => {
  await resetProjects();
  const stale = await service.createProject(actor(), { project_name: 'Stale' });
  const fresh = await service.createProject(actor(), { project_name: 'Fresh' });
  await backdate(stale.project_id, 45);
  await backdate(fresh.project_id, 3);

  const result = await runAutoArchive();
  assert.equal(result.archived, 1);
  assert.equal(result.inactive_days, DEFAULT_INACTIVE_DAYS);

  assert.notEqual(await archivedAt(stale.project_id), null);
  assert.equal(await archivedAt(fresh.project_id), null);
});

test('archived projects drop out of the dashboard list but keep their context', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Idle' });
  await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'Something worth not losing',
  });
  await backdate(project.project_id, 60);

  await runAutoArchive();

  const listed = await store.listProjects('org-system', { system: true });
  assert.equal(listed.find((p) => p.project_id === project.project_id), undefined);

  // Non-destructive: the brief is still there, just hidden.
  const stored = await store.getProject('org-system', project.project_id);
  assert.equal(stored.context.current_task, 'Something worth not losing');
});

test('restoring an auto-archived project grants it a fresh window', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Comeback' });
  await backdate(project.project_id, 90);
  await runAutoArchive();
  assert.notEqual(await archivedAt(project.project_id), null);

  await service.unarchiveProject(actor(), project.project_id);
  assert.equal(await archivedAt(project.project_id), null);

  // unarchive stamps updated_at, so an immediate re-run must not re-archive it.
  const second = await runAutoArchive();
  assert.equal(second.archived, 0);
  assert.equal(await archivedAt(project.project_id), null);
});

test('never archives an umbrella that still has a live child', async () => {
  await resetProjects();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const child = await service.createProject(actor(), {
    project_name: 'Live child',
    parent_project_id: parent.project_id,
  });
  await backdate(parent.project_id, 120);
  await backdate(child.project_id, 1);

  await runAutoArchive();
  assert.equal(await archivedAt(parent.project_id), null);
  assert.equal(await archivedAt(child.project_id), null);
});

test('a fully stale tree drains child-first across consecutive runs', async () => {
  await resetProjects();
  const parent = await service.createProject(actor(), { project_name: 'Umbrella' });
  const child = await service.createProject(actor(), {
    project_name: 'Stale child',
    parent_project_id: parent.project_id,
  });
  await backdate(parent.project_id, 120);
  await backdate(child.project_id, 120);

  const first = await runAutoArchive();
  assert.equal(first.archived, 1);
  assert.notEqual(await archivedAt(child.project_id), null);
  assert.equal(await archivedAt(parent.project_id), null, 'parent waits for the next run');

  // The parent's updated_at was never touched, so it is eligible immediately.
  const second = await runAutoArchive();
  assert.equal(second.archived, 1);
  assert.notEqual(await archivedAt(parent.project_id), null);
});

test('archiving frees the plan slot without deleting anything', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Slot holder' });
  assert.equal(await store.countTopLevelProjects('org-system'), 1);

  await backdate(project.project_id, 45);
  await runAutoArchive();

  assert.equal(await store.countTopLevelProjects('org-system'), 0);
  assert.notEqual(await store.getProject('org-system', project.project_id), null);
});

test('records an auditable project_archived event marked auto_archived', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Audited' });
  await backdate(project.project_id, 45);
  await runAutoArchive();

  const { rows } = await db.query(
    `SELECT event_kind, source_id, delta FROM context_events
      WHERE project_id = $1 AND event_kind = 'project_archived'`,
    [project.project_id],
    'org-system'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_id, 'auto-archive-job');
  const delta = typeof rows[0].delta === 'string' ? JSON.parse(rows[0].delta) : rows[0].delta;
  assert.equal(delta.metadata.auto_archived, true);
  assert.equal(delta.metadata.inactive_days, DEFAULT_INACTIVE_DAYS);
});

test('honours the disable switch and the configurable window', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Configurable' });
  await backdate(project.project_id, 10);

  assert.equal(isEnabled({ PROJECT_AUTO_ARCHIVE_ENABLED: 'false' }), false);
  const off = await runAutoArchive({ env: { PROJECT_AUTO_ARCHIVE_ENABLED: 'false' } });
  assert.equal(off.skipped, 'disabled');
  assert.equal(await archivedAt(project.project_id), null);

  // Runs by default now that start_session resurfaces archived projects, so an
  // unset flag must sweep rather than skip.
  assert.equal(isEnabled({}), true);

  // 10 days idle is inside the default window but outside a 7-day one.
  assert.equal(inactiveDays({ PROJECT_AUTO_ARCHIVE_DAYS: '7' }), 7);
  const tightened = await runAutoArchive({
    env: { PROJECT_AUTO_ARCHIVE_DAYS: '7' },
  });
  assert.equal(tightened.archived, 1);
  assert.notEqual(await archivedAt(project.project_id), null);
});

test('an aged-out owner is told their memory survives, not that it is gone', async () => {
  await resetProjects();
  const project = await service.createProject(actor(), { project_name: 'Aged Out' });
  await backdate(project.project_id, 45);
  await runAutoArchive();

  // The dashboard/brief read sees nothing...
  assert.equal((await store.listProjects('org-system', { system: true })).length, 0);

  // ...but the resurface read still finds it, which is what start_session uses
  // instead of claiming an empty workspace.
  const archived = await service.listArchivedProjectSummaries(actor());
  assert.equal(archived.length, 1);
  assert.equal(archived[0].project_name, 'Aged Out');

  const notice = formatArchivedProjectsNotice(archived);
  assert.match(notice, /archived, not gone/);
  assert.match(notice, /Aged Out/);
  assert.match(notice, new RegExp(project.project_id));
  assert.doesNotMatch(notice, /No DeerDawn context yet/);
});

test.after(async () => {
  await closeRedisConnections();
  await db.pool.end();
});

/**
 * The archived feed grew a SECOND consumer (2026-08-29).
 *
 * It was built for start_session's "your memory is intact" notice — a display
 * list, correctly bounded at 10. The MCP name->id resolver now reads the same
 * endpoint to turn a project NAME into an id, and for that a partial page is
 * not merely incomplete: with two projects sharing a normalized name (rename
 * has no duplicate gate), seeing only one of them makes the resolver's
 * ambiguity refusal pass when it should refuse, and a write lands in the wrong
 * project. So the limit is now forwardable, and aliases are selected.
 */
test('archived project summaries honour an explicit limit', async () => {
  await resetProjects();

  const a = actor();
  const created = [];
  for (let i = 0; i < 14; i += 1) {
    const p = await service.createProject(a, { project_name: `Archived Limit ${i}` });
    await store.setProjectArchived('org-system', p.project_id, new Date(Date.UTC(2026, 6, i + 1)).toISOString());
    created.push(p.project_id);
  }

  const defaulted = await service.listArchivedProjectSummaries(a);
  assert.equal(defaulted.length, 10, 'the default stays 10 so the start_session notice is unchanged');

  const full = await service.listArchivedProjectSummaries(a, { limit: 500 });
  assert.equal(full.length, 14, 'an explicit limit returns every archived project');

  // Without this the resolver cannot match on an alias for an archived project,
  // while its alias branch reads as though it works.
  assert.ok(
    full.every((row) => Array.isArray(row.aliases)),
    'every archived summary carries an aliases array'
  );
});

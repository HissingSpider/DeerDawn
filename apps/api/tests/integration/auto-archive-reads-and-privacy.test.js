'use strict';

/**
 * AUTO-ARCHIVE: BEING READ IS BEING USED, AND A PRIVATE NAME STAYS PRIVATE.
 *
 * Two defects in the nightly sweep:
 *
 *   1. "Inactive" meant "updated_at has not moved", and updated_at is stamped by
 *      writes. Delivering a brief — the thing this product does most — is a
 *      read. So a stable project opened every morning and never edited was
 *      archived at day 30 out from under the person using it.
 *
 *   2. The sweep covers every project of every owner, `personal` and `private`
 *      included, and copied each project's NAME out of the access-controlled
 *      project row into a system event. A personal project is readable by its
 *      author and nobody else, "not even a workspace owner"; its name is part
 *      of what that protects.
 *
 * DB-backed, and like auto-archive-job.test.js it clears context_projects
 * globally because the job sweeps every owner. Run against a private database:
 *   scripts/run-db-test.sh node --test tests/integration/auto-archive-reads-and-privacy.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { runAutoArchive } = require('../../src/jobs/autoArchiveJob');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const actor = () => ({ org_id: 'org-system', id: 'system-key' });

async function reset() {
  await store.clearAll();
  await db.query('DELETE FROM context_events', [], 'org-system');
  await db.query('DELETE FROM context_sessions', [], 'org-system');
  await db.query('DELETE FROM context_projects', [], 'org-system');
  await db.query('DELETE FROM product_events WHERE org_id = $1', ['org-system'], 'org-system');
}

async function backdate(projectId, days) {
  await db.query(
    `UPDATE context_projects SET updated_at = NOW() - INTERVAL '${Number(days)} days' WHERE project_id = $1`,
    [projectId], 'org-system'
  );
}

async function archivedAt(projectId) {
  const { rows } = await db.query('SELECT archived_at FROM context_projects WHERE project_id = $1', [projectId], 'org-system');
  return rows[0]?.archived_at || null;
}

async function sessionSeen(projectId, daysAgo) {
  await db.query(
    `INSERT INTO context_sessions (owner_key, session_id, tool, surface_type, project_id, last_seen_at)
     VALUES ('org-system', $1, 'claude', 'mcp', $2, NOW() - ($3 || ' days')::interval)`,
    [`sess_${crypto.randomUUID()}`, projectId, String(daysAgo)], 'org-system'
  );
}

async function briefDelivered(projectId, daysAgo) {
  // product_events.org_id references organizations.
  await db.query(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ('org-system', 'system', 'free', 'free', 'trial_active', 'organization')
     ON CONFLICT (org_id) DO NOTHING`,
    [], 'org-system'
  );
  await db.query(
    `INSERT INTO product_events (event_id, event_name, org_id, source, surface, metadata, created_at)
     VALUES ($1, 'context_delivered', 'org-system', 'context_sync', 'claude', $2::jsonb, NOW() - ($3 || ' days')::interval)`,
    [crypto.randomUUID(), JSON.stringify({ project_id: projectId }), String(daysAgo)], 'org-system'
  );
}

after(async () => {
  await reset().catch(() => {});
  await closeRedisConnections?.().catch(() => {});
  await db.pool.end().catch(() => {});
});

test('a project opened in a session yesterday is in use, however long since it was edited', async () => {
  await reset();
  const read = await service.createProject(actor(), { project_name: 'Read daily, never edited' });
  const dead = await service.createProject(actor(), { project_name: 'Genuinely abandoned' });
  await backdate(read.project_id, 45);
  await backdate(dead.project_id, 45);
  await sessionSeen(read.project_id, 1);
  // A session from before the cutoff is history, not use. Without this the
  // fix could be "never archive anything that ever had a session".
  await sessionSeen(dead.project_id, 40);

  const result = await runAutoArchive();

  assert.equal(await archivedAt(read.project_id), null, 'archived out from under the person reading it');
  assert.notEqual(await archivedAt(dead.project_id), null, 'a stale session must not keep a dead project alive');
  assert.equal(result.archived, 1);
});

test('a brief delivered last week counts as activity', async () => {
  await reset();
  const delivered = await service.createProject(actor(), { project_name: 'Delivered, not edited' });
  const other = await service.createProject(actor(), { project_name: 'Someone else got a brief' });
  await backdate(delivered.project_id, 60);
  await backdate(other.project_id, 60);
  await briefDelivered(delivered.project_id, 6);

  await runAutoArchive();

  assert.equal(await archivedAt(delivered.project_id), null);
  // The delivery names a project; it does not vouch for its neighbours.
  assert.notEqual(await archivedAt(other.project_id), null);
});

test('the name of a personal or private project is written nowhere by the sweep', async () => {
  await reset();
  const names = {
    personal: `Offer negotiation ${crypto.randomUUID()}`,
    private: `Reorg planning ${crypto.randomUUID()}`,
    shared: `Team roadmap ${crypto.randomUUID()}`,
  };
  const ids = {};
  for (const [visibility, name] of Object.entries(names)) {
    const project = await service.createProject(actor(), { project_name: name });
    ids[visibility] = project.project_id;
    await db.query('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', [visibility, project.project_id], 'org-system');
    await backdate(project.project_id, 45);
  }

  const result = await runAutoArchive();
  assert.equal(result.archived, 3, 'visibility changes what is SAID, not what is archived');

  // Look at everything the job wrote, not at the one field it is known to use.
  const { rows } = await db.query(
    'SELECT project_id, delta::text AS delta FROM context_events WHERE source_id = $1',
    ['auto-archive-job'], 'org-system'
  );
  assert.equal(rows.length, 3);
  const written = rows.map((row) => row.delta).join('\n');
  assert.ok(!written.includes(names.personal), 'a personal project name was copied out of the project row');
  assert.ok(!written.includes(names.private), 'a private project name was copied out of the project row');
  assert.ok(written.includes(names.shared), 'a shared project is already visible to the workspace and keeps its name');

  // Still attributable: the event points at the project, and the name is one
  // visibility-checked read away for anyone entitled to it.
  assert.deepEqual(rows.map((row) => row.project_id).sort(), Object.values(ids).sort());
});

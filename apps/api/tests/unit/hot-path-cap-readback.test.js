'use strict';

/**
 * recordHotPaths REPORTS WHAT IS IN THE PROJECT, NOT WHAT WAS SENT TO IT.
 *
 * hot_paths is capped at 40 and the cap used to keep the OLDEST 40 (the ranking
 * comparison tied for untagged entries, and a stable sort then kept the head).
 * So a project at the cap swallowed every new path while both callers of this
 * service — the REST route POST /projects/:id/hot-paths and the hosted
 * record_paths dispatcher — answered "Recorded N" from the request.
 *
 * Two properties are pinned here: the newest path is the one that survives the
 * cap, and the returned counts are a read-back (stored / not_stored / evicted)
 * that both callers can tell the truth from.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/hot-path-cap-readback.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-hotpaths-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

let project;

const entry = (n) => ({ label: `mod ${n}`, path: `src/mod-${n}.js`, purpose: `module ${n}` });
const storedPaths = async () => (await service.getProject(actor(), project.project_id))
  .context.hot_paths.map((item) => item.path);

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Hot paths ${RUN}` });
  // Fill the project to the cap, in batches small enough to stay a normal write.
  for (let batch = 0; batch < 4; batch += 1) {
    await service.recordHotPaths(
      actor(),
      project.project_id,
      Array.from({ length: 10 }, (_, i) => entry(batch * 10 + i + 1)),
    );
  }
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('the project really is at the cap before the interesting write', async () => {
  assert.equal((await storedPaths()).length, 40);
});

test('a path recorded at the cap is stored, and the oldest is what makes room', async () => {
  const result = await service.recordHotPaths(actor(), project.project_id, [entry('NEW')]);
  const paths = await storedPaths();

  assert.ok(paths.includes('src/mod-NEW.js'), 'THE BUG: the newest path was dropped and the caller was told "Recorded 1"');
  assert.ok(!paths.includes('src/mod-1.js'), 'the oldest entry is the one evicted');
  assert.equal(paths.length, 40);

  assert.equal(result.stored, 1, 'stored is counted from the saved project');
  assert.equal(result.not_stored, 0);
  assert.equal(result.evicted, 1, 'an old path left the brief, and the caller is owed that');
});

test('re-recording a stored path counts as stored and evicts nothing', async () => {
  const result = await service.recordHotPaths(actor(), project.project_id, [entry('NEW')]);
  assert.equal(result.stored, 1);
  assert.equal(result.not_stored, 0);
  assert.equal(result.evicted, 0, 'refreshing an entry that is already there displaces nobody');
  assert.equal((await storedPaths()).length, 40);
});

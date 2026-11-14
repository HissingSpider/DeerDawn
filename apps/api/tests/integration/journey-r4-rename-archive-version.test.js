/**
 * JOURNEY R4 — RENAME, ARCHIVE AND RESTORE ADVANCE THE BRIEF'S VERSION.
 *
 * Round 3 (S3-1) made the dashboard's brief edits carry the version they read
 * (`expected_context_version`), refused with 409 stale_context_version when the
 * brief moved on. But renaming, archiving and restoring a project changed the
 * row without moving that version. So a tab opened before the project was
 * archived still held a "current" version, and its next edit was saved into the
 * archived project as if nothing had happened.
 *
 * The owner's decision: each of the three advances `context_version`, so that
 * tab's next save is refused and the page shows the current state. A write that
 * sends NO version still behaves exactly as today, and nothing else about the
 * three routes' answers changes.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r4-rename-archive-version.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const tag = () => uuidv4().slice(0, 8);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'free', 'free', 'active', null],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${tag()}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, jwt };
}

const as = (method, path, person) => request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);

async function makeProject(person) {
  const name = `Acme storefront ${tag()}`;
  const created = await as('post', '/api/v1/context/projects', person).send({ project_name: name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.project.project_id;
  const seeded = await as('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: ['Store prices in plans.js as the single source of truth'],
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  return { id, name };
}

// What the dashboard's open tab read when it loaded.
async function tabRead(person, id) {
  const r = await as('get', `/api/v1/context/projects/${id}/inject?format=json`, person);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.context.context_version, 'number');
  return r.body.context;
}

const rowVersion = async (id) => Number((await q('SELECT context_version FROM context_projects WHERE project_id = $1', [id])).rows[0].context_version);
const rowDecisions = async (person, id) => {
  const r = await as('get', `/api/v1/context/projects/${id}/inject?format=json`, person);
  return (r.body.context?.recent_decisions || []).map((d) => (typeof d === 'string' ? d : d.summary));
};

// The tab's Pin/Edit, as the dashboard sends it: guarded on the version it read.
const tabEdit = (person, id, version, text) => as('patch', `/api/v1/context/projects/${id}/context`, person).send({
  recent_decisions: [{ summary: text }],
  expected_context_version: version,
});

test('THE BUG: a tab opened before the project was archived (and restored) can no longer save into it', async () => {
  const person = await makePerson('r4-archive');
  const { id, name } = await makeProject(person);
  const loaded = await tabRead(person, id);
  const before = await rowVersion(id);

  const archived = await as('post', `/api/v1/context/projects/${id}/archive`, person).send({});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(Object.keys(archived.body).sort(), ['archived_at', 'project_id', 'project_name'], 'the answer carries exactly what it did');
  assert.equal(archived.body.project_id, id);
  assert.equal(archived.body.project_name, name);
  assert.ok(!Number.isNaN(Date.parse(archived.body.archived_at)));
  assert.equal(await rowVersion(id), before + 1, 'archiving advanced the brief\'s version by one');

  // While it is archived the old tab's save is refused (it was before, too).
  const whileArchived = await tabEdit(person, id, loaded.context_version, 'typed while archived');
  assert.equal(whileArchived.status, 409, JSON.stringify(whileArchived.body).slice(0, 200));

  // Restored: the tab opened before the archive still holds the version it read.
  const restored = await as('post', `/api/v1/context/projects/${id}/archive`, person).send({ unarchive: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const stale = await tabEdit(person, id, loaded.context_version, 'typed in a tab opened before the archive');
  assert.equal(stale.status, 409, `THE BUG: the tab opened before the archive saved into the project: ${stale.status} ${JSON.stringify(stale.body).slice(0, 200)}`);
  assert.equal(stale.body.error, 'stale_context_version');
  const row = await q('SELECT context FROM context_projects WHERE project_id = $1', [id]);
  assert.ok(!JSON.stringify(row.rows[0].context).includes('typed in a tab opened before the archive'), 'nothing was saved');
  assert.deepEqual(await rowDecisions(person, id), ['Store prices in plans.js as the single source of truth']);
});

test('a tab opened before a rename is refused on its next save, and the rename\'s answer is unchanged', async () => {
  const person = await makePerson('r4-rename');
  const { id } = await makeProject(person);
  const loaded = await tabRead(person, id);
  const before = await rowVersion(id);

  const newName = `Acme shop ${tag()}`;
  const renamed = await as('post', `/api/v1/context/projects/${id}/rename`, person).send({ project_name: newName });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(renamed.body, { project_id: id, project_name: newName }, 'the answer is exactly what it was');
  assert.equal(await rowVersion(id), before + 1, 'renaming advanced the version by one');

  const stale = await tabEdit(person, id, loaded.context_version, 'typed before the rename');
  assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 200));
  assert.deepEqual(await rowDecisions(person, id), ['Store prices in plans.js as the single source of truth'], 'nothing was saved');

  // A tab that read after the rename saves normally.
  const fresh = await tabRead(person, id);
  const ok = await tabEdit(person, id, fresh.context_version, 'typed after the rename');
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
});

test('a tab read while the project was archived is refused after it is restored', async () => {
  const person = await makePerson('r4-restore');
  const { id, name } = await makeProject(person);
  const archived = await as('post', `/api/v1/context/projects/${id}/archive`, person).send({});
  assert.equal(archived.status, 200);
  const loaded = await tabRead(person, id);
  const before = await rowVersion(id);

  const restored = await as('post', `/api/v1/context/projects/${id}/archive`, person).send({ unarchive: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(restored.body, { project_id: id, project_name: name, archived_at: null }, 'the answer is exactly what it was');
  assert.equal(await rowVersion(id), before + 1, 'restoring advanced the version by one');

  const stale = await tabEdit(person, id, loaded.context_version, 'typed while it was archived');
  assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 200));
  const fresh = await tabRead(person, id);
  assert.equal(fresh.context_version, before + 1, 'the page shows the current state, and its version');
  const ok = await tabEdit(person, id, fresh.context_version, 'typed after the restore');
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
});

test('a write that sends NO version still behaves exactly as today after each of the three', async () => {
  const person = await makePerson('r4-unversioned');
  const { id } = await makeProject(person);
  // Today: saved after a rename, refused as project_archived while archived,
  // saved again once restored. The same after this change.
  const steps = [
    [() => as('post', `/api/v1/context/projects/${id}/rename`, person).send({ project_name: `Renamed ${tag()}` }), 200],
    [() => as('post', `/api/v1/context/projects/${id}/archive`, person).send({}), 409],
    [() => as('post', `/api/v1/context/projects/${id}/archive`, person).send({ unarchive: true }), 200],
  ];
  let expected = ['Store prices in plans.js as the single source of truth'];
  for (const [i, [step, status]] of steps.entries()) {
    const r = await step();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const legacy = await as('patch', `/api/v1/context/projects/${id}/context`, person).send({
      recent_decisions: [{ summary: `unversioned write ${i}` }],
    });
    assert.equal(legacy.status, status, `step ${i}: ${JSON.stringify(legacy.body).slice(0, 200)}`);
    if (status === 200) expected = [`unversioned write ${i}`];
    else assert.equal(legacy.body.error, 'project_archived');
    assert.deepEqual(await rowDecisions(person, id), expected);
  }
});

test('refusals the three routes gave before are given the same way', async () => {
  const person = await makePerson('r4-refusals');
  const stranger = await makePerson('r4-stranger');
  const { id } = await makeProject(person);
  const before = await rowVersion(id);

  const missingName = await as('post', `/api/v1/context/projects/${id}/rename`, person).send({});
  assert.equal(missingName.status, 400);
  assert.deepEqual(missingName.body, { error: 'project_name_required' });

  const notTheirs = await as('post', `/api/v1/context/projects/${id}/rename`, stranger).send({ project_name: 'Mine now' });
  assert.equal(notTheirs.status, 404);
  assert.deepEqual(notTheirs.body, { error: 'project_not_found' });

  const unknown = await as('post', `/api/v1/context/projects/${uuidv4()}/archive`, person).send({});
  assert.equal(unknown.status >= 400, true, 'archiving an unknown project is refused, as before');

  assert.equal(await rowVersion(id), before, 'a refused rename or archive moves nothing');
});

test('a rename sent with a guarded edit in one PATCH does not refuse its own edit; a rename-only PATCH advances the version', async () => {
  const person = await makePerson('r4-patch-rename');
  const { id } = await makeProject(person);
  const fresh = await tabRead(person, id);

  // The /memory editor sends the new name and its goals in one guarded PATCH.
  const both = await as('patch', `/api/v1/context/projects/${id}/context`, person).send({
    project_name: `Both ${tag()}`,
    goals: ['Launch the storefront'],
    expected_context_version: fresh.context_version,
  });
  assert.equal(both.status, 200, `a rename must not refuse the guarded write it travels with: ${JSON.stringify(both.body).slice(0, 200)}`);
  assert.equal(await rowVersion(id), fresh.context_version + 1, 'one request, one advance');

  const loaded = await tabRead(person, id);
  const renameOnly = await as('patch', `/api/v1/context/projects/${id}/context`, person).send({ project_name: `Only ${tag()}` });
  assert.equal(renameOnly.status, 200, JSON.stringify(renameOnly.body).slice(0, 200));
  assert.equal(await rowVersion(id), loaded.context_version + 1, 'a rename-only PATCH is a rename too');
  const stale = await tabEdit(person, id, loaded.context_version, 'typed before the rename-only PATCH');
  assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 200));
});

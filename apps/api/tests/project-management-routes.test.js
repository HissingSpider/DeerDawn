/**
 * The project mutations the dashboard's "Manage projects" dialog drives:
 * create, rename, reparent, archive, list archived, restore, delete.
 *
 * Every one of these existed before the dialog did; nothing exercised them
 * together, and DELETE resolved its project through the read path rather than
 * the mutability guard the other four use. These run against a real database.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

const httpServer = app.listen(0);

const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);
const BASE = '/api/v1/context';
const unique = (name) => `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function create(name) {
  const res = await auth(request(httpServer).post(`${BASE}/projects`)).send({ project_name: unique(name) });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.project;
}

async function liveIds() {
  const res = await auth(request(httpServer).get(`${BASE}/projects/tree`));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.projects.flatMap((p) => [p.project_id, ...(p.subprojects || []).map((s) => s.project_id)]);
}

test('project management routes', async (t) => {
  const created = [];
  t.after(async () => {
    for (const id of created) {
      await auth(request(httpServer).delete(`${BASE}/projects/${id}`)).catch(() => {});
    }
    await closeRedisConnections();
    await db.pool.end();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test('rename changes the name and reports it', async () => {
    const project = await create('pm-rename');
    created.push(project.project_id);
    const name = unique('pm-renamed');
    const res = await auth(request(httpServer).post(`${BASE}/projects/${project.project_id}/rename`)).send({ project_name: name });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.project_name, name);
  });

  await t.test('reparent nests under an umbrella and promotes back to top level', async () => {
    const umbrella = await create('pm-umbrella');
    const child = await create('pm-child');
    created.push(child.project_id, umbrella.project_id);

    const nested = await auth(request(httpServer).post(`${BASE}/projects/${child.project_id}/parent`))
      .send({ parent_project_id: umbrella.project_id });
    assert.strictEqual(nested.status, 200, JSON.stringify(nested.body));
    assert.strictEqual(nested.body.parent_project_id, umbrella.project_id);

    const promoted = await auth(request(httpServer).post(`${BASE}/projects/${child.project_id}/parent`)).send({ parent_project_id: null });
    assert.strictEqual(promoted.status, 200, JSON.stringify(promoted.body));
    assert.strictEqual(promoted.body.parent_project_id, null);
  });

  await t.test('archive hides a project, the archived list shows it, restore brings it back', async () => {
    const project = await create('pm-archive');
    created.push(project.project_id);

    const archived = await auth(request(httpServer).post(`${BASE}/projects/${project.project_id}/archive`)).send({});
    assert.strictEqual(archived.status, 200, JSON.stringify(archived.body));
    assert.ok(archived.body.archived_at);
    assert.ok(!(await liveIds()).includes(project.project_id), 'an archived project leaves the live tree');

    const list = await auth(request(httpServer).get(`${BASE}/projects?archived=1&limit=500`));
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.projects.some((p) => p.project_id === project.project_id), 'and appears in the archived list');

    const restored = await auth(request(httpServer).post(`${BASE}/projects/${project.project_id}/archive`)).send({ unarchive: true });
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
    assert.ok((await liveIds()).includes(project.project_id), 'a restored project is live again');
  });

  await t.test('archiving a parent with live children refuses with a 409 and says what to do', async () => {
    // This answered 500 "An unexpected error occurred". contextSyncService
    // throws `archive_parent_with_children` bare, the route passes it to
    // next(err), and nothing classified it — so a deliberate refusal arrived as
    // a server fault: no way to act on it, and filed in Error Tracking as our
    // bug. The refusal is the FEATURE (archiving an umbrella would hide live
    // work out from under the user), so it has to read like one.
    const umbrella = await create('pm-archive-parent');
    const child = await create('pm-archive-child');
    created.push(child.project_id, umbrella.project_id);

    const nested = await auth(request(httpServer).post(`${BASE}/projects/${child.project_id}/parent`))
      .send({ parent_project_id: umbrella.project_id });
    assert.strictEqual(nested.status, 200, JSON.stringify(nested.body));

    const res = await auth(request(httpServer).post(`${BASE}/projects/${umbrella.project_id}/archive`)).send({});
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'archive_parent_with_children');
    assert.match(res.body.message, /subprojects/i, 'the caller has to be told what to do first');
    assert.ok((await liveIds()).includes(umbrella.project_id), 'and nothing was archived');
  });

  await t.test('archiving or moving a project that is not there is a 404, not a 500', async () => {
    // assertProjectMutable answers `project_not_found` both for a project that
    // does not exist and for one the caller may not touch — deliberately the
    // same code, so a refusal cannot confirm a colleague's project exists. It
    // was unclassified too, so a member archiving a colleague's shared project
    // got a 500.
    const missing = 'project_does_not_exist_scan6';
    const archived = await auth(request(httpServer).post(`${BASE}/projects/${missing}/archive`)).send({});
    assert.strictEqual(archived.status, 404, JSON.stringify(archived.body));
    assert.strictEqual(archived.body.error, 'project_not_found');

    const moved = await auth(request(httpServer).post(`${BASE}/projects/${missing}/parent`)).send({});
    assert.strictEqual(moved.status, 404, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.error, 'project_not_found');
  });

  await t.test('delete removes a project the caller may modify, and a second delete is a 404', async () => {
    const project = await create('pm-delete');
    const first = await auth(request(httpServer).delete(`${BASE}/projects/${project.project_id}`));
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.ok(!(await liveIds()).includes(project.project_id));
    const second = await auth(request(httpServer).delete(`${BASE}/projects/${project.project_id}`));
    assert.strictEqual(second.status, 404, JSON.stringify(second.body));
  });
});

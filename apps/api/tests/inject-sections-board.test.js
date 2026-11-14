/**
 * GET /projects/:id/inject?sections=board — the board is servable by name.
 *
 * The regression this guards: the allow-list on this route had no board entry,
 * and an unknown name is DROPPED rather than rejected, so the route answered
 * 200 with a payload containing no board and no error. A caller could not tell
 * "you have no cards" from "this route does not serve cards" — and the board was
 * reachable the whole time via sections=all, so nothing was being withheld,
 * only unnameable.
 */
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');
const { ensureDatabaseAvailable } = require('./helpers/dbAvailability');

// One server for the file — see layer3-context-sync.test.js for why a bare app
// under supertest churns connections.
const httpServer = app.listen(0);

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const CARD_TITLE = `Board section card ${uuidv4().slice(0, 8)}`;
const CARD_BODY = 'Detail that lives in the body, not the title.';

let projectId = null;

test.after(async () => {
  if (projectId) {
    await db.query('DELETE FROM context_events WHERE project_id = $1', [projectId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE project_id = $1', [projectId], 'org-system').catch(() => {});
  }
  await new Promise((resolve) => httpServer.close(resolve));
  await closeRedisConnections().catch(() => {});
  await db.pool.end().catch(() => {});
});

test('a project with a board card can be asked for its board by name', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'inject sections=board'))) return;

  const created = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('X-Api-Key', API_KEY)
    .send({ project_name: `Board sections ${uuidv4().slice(0, 8)}`, current_task: 'Serve the board by name' });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  projectId = created.body.project?.project_id || created.body.project_id;
  assert.ok(projectId, 'project_id missing from create response');

  const patched = await request(httpServer)
    .patch(`/api/v1/context/projects/${projectId}/context`)
    .set('X-Api-Key', API_KEY)
    .send({ add_todos: [{ title: CARD_TITLE, body: CARD_BODY, phase: 'in_progress' }] });
  assert.ok(patched.status < 300, `patch failed: ${patched.status} ${JSON.stringify(patched.body)}`);

  await t.test('sections=board renders the board', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject`)
      .query({ sections: 'board' })
      .set('X-Api-Key', API_KEY);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.payload.body.includes(CARD_TITLE), `board missing from payload: ${res.body.payload.body}`);
    // The brief prints the marker, never the body — a board listing that inlined
    // card detail is the token blowout the body was scoped to avoid.
    assert.ok(!res.body.payload.body.includes(CARD_BODY), 'the brief must not inline a card body');
  });

  await t.test('sections=todos renders the same board', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject`)
      .query({ sections: 'todos' })
      .set('X-Api-Key', API_KEY);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.payload.body.includes(CARD_TITLE));
  });

  await t.test('an unknown section is still dropped, not served', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject`)
      .query({ sections: 'board,not_a_section' })
      .set('X-Api-Key', API_KEY);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.payload.sections, ['board']);
  });

  await t.test('sections=all already carried the board — this widened nothing', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject`)
      .query({ sections: 'all' })
      .set('X-Api-Key', API_KEY);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.payload.body.includes(CARD_TITLE));
  });
});

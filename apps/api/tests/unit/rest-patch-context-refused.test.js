process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * A 200 CARRYING THE OLD VALUE AND NO REASON ANYBODY READS.
 *
 * updateProjectContext refuses a field rather than blanking it, and travels a
 * `refused` list so the caller can say WHICH field the server would not take
 * and why. PATCH /projects/:id/context put that list inside the serialised
 * PROJECT, because serializeProjectFull passes everything but the event log
 * through. It describes the request, not the project, and no client reaches for
 * project.refused — so a declined write was, to every consumer, a 200 with the
 * old value and no explanation.
 *
 * Additive on both counts: the nested copy stays where it was, and a write with
 * nothing refused still answers with `project` alone.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/rest-patch-context-refused.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);

test('a refused field is named in the PATCH reply', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'patch refusal')) return;
  if (!await ensureDatabaseAvailable(t, db, 'patch refusal')) return;

  const created = await auth(request(httpServer).post('/api/v1/context/projects'))
    .send({ project_name: `Refusal ${uuidv4().slice(0, 8)}` });
  const id = created.body?.project_id || created.body?.project?.project_id;
  assert.ok(id, 'project should have been created');

  await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ current_status: 'Invites send, acceptance is half wired' });

  const refusedWrite = await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ current_status: 'connection check only' });

  assert.equal(refusedWrite.status, 200);
  assert.ok(
    Array.isArray(refusedWrite.body?.refused),
    'THE BUG: the refusal was reachable only at project.refused, where no client looks',
  );
  assert.ok(refusedWrite.body.refused.some((item) => item.field === 'current_status'));
  assert.match(refusedWrite.body.refused[0].reason, /connection/i, 'the caller is told WHY');
  assert.equal(
    refusedWrite.body?.project?.context?.current_status,
    'Invites send, acceptance is half wired',
    'and the value that was there is untouched',
  );

  const clean = await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ current_status: 'Acceptance is wired end to end' });
  assert.equal(clean.status, 200);
  assert.equal(clean.body.refused, undefined, 'nothing refused, nothing reported');

  try { await auth(request(httpServer).delete(`/api/v1/context/projects/${id}`)); } catch { /* cleanup is best-effort */ }
});

/**
 * THE LOCAL MCP SERVER REACHES THE SAME FUNCTION THROUGH THIS ROUTE.
 *
 * packages/mcp-server composes `Completed: <the stored task>` for finish_task
 * and PATCHes it here, so the refusal that made the hosted dispatcher announce
 * a completion the brief never got arrived on this path too, with the same
 * cause and no separate fix. Pinned on the wire, because "the service function
 * is fixed" and "both dispatchers are fixed" are different claims.
 */
test('a completion status quoting the stored task lands over REST', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'completion status')) return;
  if (!await ensureDatabaseAvailable(t, db, 'completion status')) return;

  const created = await auth(request(httpServer).post('/api/v1/context/projects'))
    .send({ project_name: `Completion ${uuidv4().slice(0, 8)}` });
  const id = created.body?.project_id || created.body?.project?.project_id;
  assert.ok(id, 'project should have been created');

  // A real task whose words are the connection-probe vocabulary. The explicit
  // exemption stores it; everything after depends on that.
  const task = 'Run the smoke test';
  const set = await auth(request(httpServer).patch(`/api/v1/context/${id}/context`)).send({ current_task: task });
  assert.equal(set.body?.project?.context?.current_task, task);

  const finished = await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ current_status: `Completed: ${task}`, task_progress: 'completed' });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.refused, undefined, 'THE BUG: the server refused its own composition');
  assert.equal(finished.body?.project?.context?.current_status, `Completed: ${task}`);

  // And it survives the next write that touches something else: the repair pass
  // re-normalises the whole stored context, which is where it was blanked a
  // second time.
  const later = await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ description: 'Scan round 8 fixes' });
  assert.equal(
    later.body?.project?.context?.current_status,
    `Completed: ${task}`,
    'a stored completion must not be re-blanked by an unrelated later write',
  );

  try { await auth(request(httpServer).delete(`/api/v1/context/projects/${id}`)); } catch { /* cleanup is best-effort */ }
});

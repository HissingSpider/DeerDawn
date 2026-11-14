process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * Two write paths, two semantics, and which is which.
 *
 *   PATCH /context (updateProjectContext) is a REPLACE: the stored array becomes
 *   the array that was sent. That is what lets the dashboard delete an entry,
 *   and it is why a caller that DERIVES a stack (project-sync.ts infers one from
 *   package.json on every session start) must send the union with what is
 *   stored, never a guess built from an absent read. Pinned over HTTP below.
 *
 *   The extraction MERGE (mergeContextObject) is a UNION. This file used to pin
 *   it as a replace too, "because that is what lets the dashboard delete an
 *   entry" — but the dashboard never reaches the merge; only extraction does.
 *   An extraction delta names what one conversation mentioned, and
 *   sanitizeExtraction strips what is already stored, so a replacing merge
 *   turned stored [Rust, Kubernetes] + model [Rust, Express] into [Express]:
 *   one new entry deleted the rest. That test was pinning the bug.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { mergeContextObject } = require('../../../../packages/shared-context/src/index.js');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);

test('tech_stack delta semantics', async (t) => {
  await t.test('an extraction delta ADDS to the stored array and never shortens it', () => {
    const merged = mergeContextObject(
      { project_name: 'Atlas', tech_stack: ['Rust', 'Kubernetes'] },
      { tech_stack: ['Express'] },
      'test',
    );
    assert.deepEqual(merged.tech_stack, ['Rust', 'Kubernetes', 'Express']);
  });

  await t.test('an absent tech_stack leaves the stored array untouched', () => {
    const merged = mergeContextObject({ project_name: 'Atlas', tech_stack: ['Rust'] }, {}, 'test');
    assert.deepEqual(merged.tech_stack, ['Rust']);
  });

  await t.test('a union delta keeps the curated entries and adds the new ones', () => {
    const merged = mergeContextObject(
      { project_name: 'Atlas', tech_stack: ['Rust', 'Kubernetes'] },
      { tech_stack: ['Rust', 'Kubernetes', 'Express'] },
      'test',
    );
    assert.deepEqual(merged.tech_stack, ['Rust', 'Kubernetes', 'Express']);
  });
});

/**
 * The end of the same story, over HTTP: what project-sync now sends has to
 * leave the STORED stack intact, not merely look right in the payload.
 */
test('a derived stack patch leaves the stored curated entries in place', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'tech_stack round-trip')) return;
  if (!await ensureDatabaseAvailable(t, db, 'tech_stack round-trip')) return;

  const created = await auth(request(httpServer).post('/api/v1/context/projects'))
    .send({ project_name: `Stack Union ${uuidv4().slice(0, 8)}` });
  const id = created.body?.project_id || created.body?.project?.project_id;
  assert.ok(id, 'project should have been created');

  const CURATED = ['Rust', 'Kubernetes', 'Terraform'];
  await auth(request(httpServer).patch(`/api/v1/context/${id}/context`)).send({ tech_stack: CURATED });

  // What the sync sends now: the stored stack unioned with the new guesses.
  await auth(request(httpServer).patch(`/api/v1/context/${id}/context`))
    .send({ tech_stack: [...CURATED, 'Express', 'Zod'] });

  const after = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject`)).query({ format: 'json' });
  const stored = after.body?.context?.tech_stack || [];
  for (const entry of CURATED) {
    assert.ok(stored.includes(entry), `curated entry ${entry} must survive the sync — stored: ${stored.join(', ')}`);
  }
  assert.ok(stored.includes('Express'), 'the new guess should still be added');

  // And the shape of the bug, so nobody "simplifies" the union away: sending the
  // guess ALONE (what an absent read produced) destroys the curated entries.
  await auth(request(httpServer).patch(`/api/v1/context/${id}/context`)).send({ tech_stack: ['Express', 'Zod'] });
  const wiped = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject`)).query({ format: 'json' });
  assert.deepEqual(wiped.body?.context?.tech_stack, ['Express', 'Zod']);

  try { await auth(request(httpServer).delete(`/api/v1/context/projects/${id}`)); } catch { /* cleanup is best-effort */ }
});

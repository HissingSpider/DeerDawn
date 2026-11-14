/**
 * Compounding intelligence — persistent cross-project affinity.
 *
 * The more two projects co-occur in a workspace's context, the stronger their
 * learned link. getRelatedProjectsByAffinity reads it back ranked, so "projects
 * you work alongside" becomes durable, accumulated knowledge — not a per-call
 * recomputation, and not something an exported file carries.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-cross-project-affinity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

function newProject(name) {
  return service.createProject(actor(), { project_name: name, description: '', goals: [], current_status: '' });
}

test('affinity accumulates across co-occurrences and reads back ranked', async () => {
  await store.clearAll();
  const a = await newProject('Alpha');
  const b = await newProject('Bravo');
  const c = await newProject('Charlie');

  await service.recordProjectAffinities(actor(), a.project_id, [b.project_id]);
  await service.recordProjectAffinities(actor(), a.project_id, [b.project_id, c.project_id]);
  // Direction-independent: recording from B's side strengthens the same A↔B pair.
  await service.recordProjectAffinities(actor(), b.project_id, [a.project_id]);

  const related = await service.getRelatedProjectsByAffinity(actor(), a.project_id);
  assert.equal(related.length, 2, 'two distinct related projects');
  assert.equal(related[0].project_id, b.project_id, 'strongest pair surfaces first');
  assert.equal(related[0].co_occurrence_count, 3, 'A↔B counted three times regardless of direction');
  assert.equal(related[0].project_name, 'Bravo', 'resolves the related project name');
  assert.equal(related[1].project_id, c.project_id);
  assert.equal(related[1].co_occurrence_count, 1);
});

test('self-links and empty inputs are no-ops', async () => {
  await store.clearAll();
  const a = await newProject('Solo');
  await service.recordProjectAffinities(actor(), a.project_id, [a.project_id]); // self → ignored
  await service.recordProjectAffinities(actor(), a.project_id, []);             // empty → no-op
  const related = await service.getRelatedProjectsByAffinity(actor(), a.project_id);
  assert.deepEqual(related, []);
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

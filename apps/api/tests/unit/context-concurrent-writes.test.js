'use strict';

/**
 * Concurrent writes must not lose a delta.
 *
 * This is the failure a memory product can least afford: two agents flushing
 * within the same second, one person's session silently gone, and the customer
 * concluding that DeerDawn forgot what they told it. Invisible on a single-user
 * account, routine with four engineers on one workspace.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-concurrent-writes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const { closeRedisConnections } = require('../../src/config/redis');

const OWNER = 'org-system';
const actor = () => ({ org_id: OWNER, id: 'user-cas' });

function extraction(projectId, delta) {
  return {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: projectId, project_name: 'CasProj', reason: 'same repo' },
    delta,
    should_create_project: false,
    needs_user_confirmation: false,
  };
}

test('a stale write is refused rather than applied', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });

  const loaded = await store.getProject(OWNER, project.project_id);

  // Someone else writes first.
  await store.saveProject(
    { ...loaded, project_name: 'Renamed by someone else', updated_at: new Date().toISOString() },
    actor(),
  );

  // Our write was computed against the version we loaded, which is now stale.
  // Under the old read-compare-then-write scheme this landed and silently
  // discarded the rename; the swap must refuse it instead.
  const result = await store.saveProject(
    { ...loaded, project_name: 'Stale overwrite', updated_at: new Date().toISOString() },
    actor(),
    { expectedVersion: loaded.context_version },
  );
  assert.equal(result.applied, false, 'a write against a stale version must not apply');

  const after = await store.getProject(OWNER, project.project_id);
  assert.equal(after.project_name, 'Renamed by someone else', 'the concurrent write survived');
});

test('a write against the current version applies', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });
  const loaded = await store.getProject(OWNER, project.project_id);

  const result = await store.saveProject(
    { ...loaded, project_name: 'Fresh write', updated_at: new Date().toISOString() },
    actor(),
    { expectedVersion: loaded.context_version },
  );
  assert.equal(result.applied, true, 'a non-stale write must apply');

  const after = await store.getProject(OWNER, project.project_id);
  assert.equal(after.project_name, 'Fresh write');
});

test('two writes in the same millisecond cannot both win', async () => {
  // The guard used to compare updated_at truncated to milliseconds, so two
  // writes landing inside one millisecond both passed it — the exact collision a
  // swap exists to catch, and the likeliest one on a hot project. A counter has
  // no precision to lose, so the second writer against the same version loses
  // however close together they are.
  //
  // Mutation-tested: restoring the old date_trunc guard turns this red.
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });
  const loaded = await store.getProject(OWNER, project.project_id);
  const sameInstant = new Date().toISOString();

  const first = await store.saveProject(
    { ...loaded, project_name: 'First', updated_at: sameInstant },
    actor(),
    { expectedVersion: loaded.context_version },
  );
  const second = await store.saveProject(
    { ...loaded, project_name: 'Second', updated_at: sameInstant },
    actor(),
    { expectedVersion: loaded.context_version },
  );

  assert.equal(first.applied, true, 'the first write wins');
  assert.equal(second.applied, false, 'the second, against the same version, must lose');
  assert.equal((await store.getProject(OWNER, project.project_id)).project_name, 'First');
});

test('the version moves on an unguarded write too', async () => {
  // Otherwise a guarded writer could swap successfully against a row that an
  // unguarded one had already changed underneath it.
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });
  const loaded = await store.getProject(OWNER, project.project_id);
  await store.saveProject({ ...loaded, project_name: 'Unguarded', updated_at: new Date().toISOString() }, actor());

  const after = await store.getProject(OWNER, project.project_id);
  assert.ok(after.context_version > loaded.context_version, 'an unguarded write still bumps the version');

  const stale = await store.saveProject(
    { ...loaded, project_name: 'Stale', updated_at: new Date().toISOString() },
    actor(),
    { expectedVersion: loaded.context_version },
  );
  assert.equal(stale.applied, false, 'and a swap against the old version then loses');
});

test('an unguarded save stays unconditional', async () => {
  // Every existing caller passes no expectation and must keep working exactly as
  // it did — including the last-write-wins fallback the retry loop falls back to.
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });
  const loaded = await store.getProject(OWNER, project.project_id);
  await store.saveProject({ ...loaded, project_name: 'A', updated_at: new Date().toISOString() }, actor());

  const result = await store.saveProject(
    { ...loaded, project_name: 'B', updated_at: new Date().toISOString() },
    actor(),
  );
  assert.equal(result.applied, true, 'an unguarded write applies even against a stale snapshot');
  assert.equal((await store.getProject(OWNER, project.project_id)).project_name, 'B');
});

test('concurrent extractions all survive', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'CasProj', description: 'x', goals: [], current_status: '',
  });

  // Five agents flushing a distinct decision at once. Every one must end up in
  // the brief: this is the whole promise, and the retry loop plus the swap is
  // what keeps it true.
  // Substantive and distinct: the quality guards (isVagueDecision, the
  // minimum-length checks) correctly drop a bare "Alpha decided", so a test
  // written that way measures the guards rather than the race.
  const summaries = [
    'Alpha moved the Redis cache TTL to 30 seconds',
    'Bravo switched the staging migration runner to serial mode',
    'Charlie pinned the Postgres driver to 8.11 for the prepared-statement fix',
    'Delta moved session storage out of memory and into Redis',
    'Echo dropped the legacy webhook retry queue entirely',
  ];
  // NOT wrapped in .catch(). An earlier version of this test swallowed rejections
  // so that a hard crash inside applyExtraction — a variable referenced in its
  // temporal dead zone — presented as "all five decisions were lost to a race".
  // Swallowing an error to make a test tolerant is the same silent-success shape
  // this suite exists to catch.
  const results = await Promise.allSettled(summaries.map((summary, i) => service.applyExtraction(actor(), {
    session_id: `s-cas-${i}`,
    tool: 'claude_code',
    session_context: { cwd: '/repo', host: `h${i}`, status: 'active' },
    chunks: [{ role: 'assistant', text: summary }],
    extraction: extraction(project.project_id, {
      recent_decisions: [{ summary, decided_at: new Date().toISOString() }],
    }),
  })));

  const failed = results.filter((r) => r.status === 'rejected');
  assert.deepEqual(
    failed.map((r) => String(r.reason?.message || r.reason)), [],
    'no extraction may throw — a rejection here would masquerade as a lost write',
  );

  const after = await store.getProject(OWNER, project.project_id);
  const stored = (after.context?.recent_decisions || []).map((d) => d.summary);
  const missing = summaries.filter((s) => !stored.includes(s));
  assert.deepEqual(missing, [], `every concurrent decision must survive; lost: ${missing.join(', ')}`);
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

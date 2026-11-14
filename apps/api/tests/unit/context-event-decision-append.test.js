/**
 * A structured event ADDS to the decision log. It never replaces it.
 *
 * `applyStructuredContextEvent` builds nearly every patch as an append: read the
 * current list, push one entry, save the result. It read that list through
 * `getProject`, which hands a teammate the section-FILTERED view — so on a
 * narrowly-shared project the "current list" of a withheld section was EMPTY,
 * the append produced a one-item list, and the save wrote it over the author's
 * entire history. Measured before the fix: two of Alice's decisions, one
 * `decision_made` from Bob, and Alice's log came back as `['Bob decision']` with
 * the call returning `status: accepted`.
 *
 * Three things now stand between that and the data, because one of them being
 * right is not a property anybody can check at a glance:
 *   1. the event path loads the RAW row (loadProjectForWrite), like every other
 *      write path in the service already does;
 *   2. a section outside the share is not writable at all — writing what you
 *      cannot read is the precondition for a blind overwrite;
 *   3. a non-author's `recent_decisions` patch is unioned onto the stored list,
 *      so a teammate's write can only ever grow the log.
 *
 * Multi-user, DB-backed; run via scripts/run-db-test.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const alice = () => ({ org_id: 'org-system', id: 'user-alice' });
const bob = () => ({ org_id: 'org-system', id: 'user-bob' });

const ALICE_DECISIONS = [
  { summary: 'Sharing has exactly one switch', decided_at: '2026-09-01T10:00:00.000Z', importance: 'high' },
  { summary: 'owner_key comes from workspaceService', decided_at: '2026-09-02T10:00:00.000Z', importance: 'high' },
];

async function freshWorkspace() {
  await store.clearAll();
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    ['org-system'],
    'org-system'
  ).catch(() => {});
  await workspace.addMember('org-system', 'user-alice', { role: 'owner' });
  await workspace.addMember('org-system', 'user-bob', { role: 'member' });
}

/**
 * Alice's project with a real decision history, shared with the workspace.
 * `sections === null` leaves the share row absent — "shared, default sections".
 */
async function sharedProjectWithDecisions(sections = null) {
  const project = await service.createProject(alice(), {
    project_name: 'DecisionProj',
    description: 'a shared project with history',
    goals: [],
    current_status: '',
  });
  await service.updateProjectContext(alice(), project.project_id, {
    recent_decisions: ALICE_DECISIONS,
    shipped: [{ summary: 'Teams shipped', shipped_at: '2026-09-02T10:00:00.000Z' }],
  });
  await db.query(
    'UPDATE context_projects SET visibility = $2 WHERE project_id = $1',
    [project.project_id, 'shared'],
    'org-system'
  );
  if (sections) {
    await store.upsertProjectShare(project.project_id, {
      org_id: 'org-system',
      enabled: true,
      created_by: 'user-alice',
      updated_by: 'user-alice',
      sections: sections.map((section_key) => ({ section_key, can_view: true, can_edit: true })),
      members: [],
    });
  }
  return project;
}

async function decisionSummaries(actor, projectId) {
  const project = await service.getProject(actor, projectId);
  return (project.context.recent_decisions || []).map((d) => d.summary);
}

test('a member event cannot wipe the decision log of a NARROWLY shared project', async () => {
  await freshWorkspace();
  // recent_decisions is deliberately NOT in the share. This is the exact shape
  // that destroyed the log: withheld on read, still writable on write.
  const project = await sharedProjectWithDecisions(['current_task', 'current_status']);

  await service.applyStructuredContextEvent(bob(), {
    project_id: project.project_id,
    event_type: 'decision_made',
    summary: 'Bob decision',
    source_tool: 'claude_code',
    metadata: {},
  }).catch(() => null); // refusing is a fine outcome; destroying the log is not.

  assert.deepEqual(
    await decisionSummaries(alice(), project.project_id),
    ALICE_DECISIONS.map((d) => d.summary),
    'the author\'s decisions survive a member event against a section they cannot read'
  );
});

test('a member event APPENDS when the decision section IS shared', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithDecisions(); // defaults include recent_decisions

  const result = await service.applyStructuredContextEvent(bob(), {
    project_id: project.project_id,
    event_type: 'decision_made',
    summary: 'Bob decision',
    source_tool: 'claude_code',
    metadata: {},
  });
  assert.equal(result.status, 'accepted');

  assert.deepEqual(
    await decisionSummaries(alice(), project.project_id),
    [...ALICE_DECISIONS.map((d) => d.summary), 'Bob decision'],
    'the member adds one entry and keeps every existing one'
  );
});

test('an owner event appends to its own log rather than restarting it', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithDecisions();

  await service.applyStructuredContextEvent(alice(), {
    project_id: project.project_id,
    event_type: 'decision_made',
    summary: 'Alice decision three',
    source_tool: 'claude_code',
    metadata: {},
  });

  assert.deepEqual(
    await decisionSummaries(alice(), project.project_id),
    [...ALICE_DECISIONS.map((d) => d.summary), 'Alice decision three']
  );
});

test('the same guard covers the other append-shaped sections (shipped)', async () => {
  await freshWorkspace();
  // `shipped` is outside DEFAULT_SHARED_SECTIONS, so it is withheld on read —
  // the same trap decision_made fell into, one field over.
  const project = await sharedProjectWithDecisions();

  await service.applyStructuredContextEvent(bob(), {
    project_id: project.project_id,
    event_type: 'feature_shipped',
    summary: 'Bob shipped something',
    source_tool: 'claude_code',
    metadata: {},
  }).catch(() => null);

  const owner = await service.getProject(alice(), project.project_id);
  assert.ok(
    (owner.context.shipped || []).some((s) => s.summary === 'Teams shipped'),
    'the author\'s shipped history survives a member event'
  );
});

test('a teammate\'s direct patch can grow the decision log but never shrink it', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithDecisions();

  // A short list is exactly what a stale or filtered client sends. Spread over
  // the stored value it would delete the rest.
  await service.updateProjectContext(bob(), project.project_id, {
    recent_decisions: [
      { summary: 'Bob only', decided_at: '2026-09-03T10:00:00.000Z', importance: 'normal' },
    ],
  });

  assert.deepEqual(
    await decisionSummaries(alice(), project.project_id),
    [...ALICE_DECISIONS.map((d) => d.summary), 'Bob only'],
    'the union keeps every stored entry and adds the new one'
  );
});

test('the author can still edit their own log — the merge is not a global freeze', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithDecisions();

  await service.updateProjectContext(alice(), project.project_id, {
    recent_decisions: [ALICE_DECISIONS[0]],
  });

  assert.deepEqual(
    await decisionSummaries(alice(), project.project_id),
    [ALICE_DECISIONS[0].summary],
    'removing your own decision is a real operation and must keep working'
  );
});

test('five decisions in a row all survive a log the floor stamped `high`', async () => {
  // THE LIVE SHAPE OF THE BUG. Every structured-event floor write was stamped
  // `high` until #495, so an active project holds twenty `high` entries dated
  // inside the recency window, and a new entry defaults to `normal`. While
  // eviction read the stamp, each decision was the cheapest thing in the log
  // the moment it stopped being the entry written in THIS call, so the NEXT
  // write evicted it: five saves, one survivor, and `accepted` every time.
  await freshWorkspace();
  const project = await sharedProjectWithDecisions();
  const day = 24 * 60 * 60 * 1000;
  await service.updateProjectContext(alice(), project.project_id, {
    recent_decisions: Array.from({ length: 20 }, (_, i) => ({
      summary: `Growth run log ${i}: nothing to act on`,
      importance: 'high',
      decided_at: new Date(Date.now() - (13 - i / 2) * day).toISOString(),
    })),
  });

  const written = ['DECISION one', 'DECISION two', 'DECISION three', 'DECISION four', 'DECISION five'];
  for (const summary of written) {
    const result = await service.applyStructuredContextEvent(alice(), {
      project_id: project.project_id,
      event_type: 'decision_made',
      summary,
      source_tool: 'claude_code',
      metadata: {},
    });
    assert.equal(result.status, 'accepted');
  }

  const stored = await decisionSummaries(alice(), project.project_id);
  assert.equal(stored.length, 20);
  assert.deepEqual(
    stored.filter((s) => s.startsWith('DECISION')),
    written,
    'THE BUG: each decision survived exactly one write while the run-logs kept their seats'
  );
  for (let i = 0; i < 5; i += 1) {
    assert.ok(!stored.includes(`Growth run log ${i}: nothing to act on`), 'the five oldest entries should have gone');
  }
  assert.ok(stored.includes('Growth run log 19: nothing to act on'));
});

test.after(async () => {
  // 'org-system' is a SHARED sentinel across suites: leaving these rows behind
  // makes every later suite's solo workspace look like a two-person team, and
  // the workspace write check then refuses writes those suites depend on. The
  // before-hook's delete is not enough — it only protects THIS file.
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    ['org-system'],
    'org-system'
  ).catch(() => {});
  await closeRedisConnections();
});

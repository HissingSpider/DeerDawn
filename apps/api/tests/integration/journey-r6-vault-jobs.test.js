/**
 * JOURNEY ROUND 6 — THE NIGHTLY VAULT JOB.
 *
 * Owner decisions (round 3, "Vault phases 2 and 7" and "Indexes; cross-account
 * write in the vault job"):
 *
 *   1. Phases 2 and 7 are retired. Phase 2 rewrote any 2023 decided_at, and a
 *      real 2023 date cannot be told from an invented one. Phase 7 cleared a
 *      blocker on a word match. Neither runs, and nothing can switch them back
 *      on: the code is gone, so no config, flag or env var reaches it.
 *   2. Phase 6 refuses when the two owners differ. A resolved decision node
 *      filed under another owner's project is never applied to that project.
 *
 * DB-backed, with ENCRYPTION_MASTER_KEY set as production is:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r6-vault-jobs.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const vault = require('../../src/jobs/vaultRemediationJob');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOwner(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active', 5],
  );
  const userId = `user-${uuidv4()}`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, 'x', 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  return { orgId, userId, actor: { id: userId, org_id: orgId, workspace_key: orgId, type: 'user', role: 'admin' } };
}

// A project of its own, with the given context, written through the store so it
// is sealed at rest as production's is.
async function makeProject(owner, label, context) {
  const projectId = `proj-r6-${uuidv4()}`;
  const now = new Date().toISOString();
  await store.saveProject({
    project_id: projectId, owner_key: owner.orgId, project_name: `${label} ${projectId.slice(-6)}`,
    context: { project_name: `${label}`, ...context }, created_at: now, updated_at: now,
  }, owner.actor);
  return projectId;
}

async function contextOf(owner, projectId) {
  const project = await store.getProject(owner.orgId, projectId);
  return { context: project.context, updated_at: project.updated_at };
}

async function resolvedNode(ownerKey, projectId, title) {
  const now = new Date().toISOString();
  await store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, node_type: 'decision',
    canonical_key: `decision:${uuidv4()}`, title, summary: title,
    metadata: { entity_type: 'decision', scope: 'project', status: 'resolved', resolved_at: now }, confidence: 0.9,
    source_session_id: '', source_tool: 'claude_code', created_at: now, updated_at: now, last_seen_at: now,
  });
}

// Runs fn with console output captured; returns what was logged and warned.
async function captured(fn) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { logs.push(['log', a.join(' ')]); };
  console.warn = (...a) => { logs.push(['warn', a.join(' ')]); };
  console.error = (...a) => { logs.push(['error', a.join(' ')]); };
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return logs;
}

// ── Phases 2 and 7 are retired ──────────────────────────────────────────────

test('phases 2 and 7 are retired: the whole nightly run leaves a 2023 date and a blocker exactly as written', async () => {
  const owner = await makeOwner('retired');
  const DATE_2023 = '2023-03-14T09:00:00.000Z';
  const blocker = 'Stripe webhook signature verification failing on staging';
  const P = await makeProject(owner, 'Retired', {
    recent_decisions: [
      { summary: 'Chose Postgres over MongoDB for the ledger', decided_at: DATE_2023 },
      // Newer than the blocker, resolution language, and enough shared words:
      // the exact shape phase 7 used to clear.
      { summary: 'Resolved: Stripe webhook signature verification failing on staging is fixed and deployed', decided_at: new Date(Date.now() + 5000).toISOString() },
    ],
    blocking_issue: blocker,
    blocking_issue_set_at: new Date(Date.now() - 3600000).toISOString(),
  });
  const before = await contextOf(owner, P);

  const logs = await captured(() => vault.runVaultRemediation());

  const after = await contextOf(owner, P);
  assert.deepEqual(after, before, 'neither the date nor the blocker was touched');
  assert.equal(after.context.recent_decisions[0].decided_at, DATE_2023);
  assert.equal(after.context.recent_decisions[0].timestamp_repaired, undefined);
  assert.equal(after.context.blocking_issue, blocker);
  assert.equal(after.context.blocker_reconciled_at, undefined);

  const phases = logs
    .filter(([level]) => level === 'log')
    .map(([, line]) => /^\[VAULT-REMEDIATION\] Phase (\d+)[: ]/.exec(line))
    .filter(Boolean).map((m) => Number(m[1]));
  assert.deepEqual(phases, [1, 3, 4, 5, 6, 8], 'phases 2 and 7 do not run and do not log; the others keep their numbers');
  const summary = logs.map(([, line]) => line).find((line) => line.includes('Done in'));
  assert.ok(summary, 'the run summary was logged');
  assert.doesNotMatch(summary, /timestamps=|blockersReconciled=/, 'the summary no longer reports the retired phases');
});

test('phases 2 and 7 cannot be re-enabled by accident: no function, export or option reaches them', () => {
  assert.equal(vault.repairFakeTimestamps, undefined, 'phase 2 is not exported');
  assert.equal(vault.reconcileStaleBlockers, undefined, 'phase 7 is not exported');
  const source = fs.readFileSync(path.join(__dirname, '../../src/jobs/vaultRemediationJob.js'), 'utf8');
  for (const gone of ['repairFakeTimestamps', 'reconcileStaleBlockers', 'timestamp_repaired', 'blocker_reconciled_at', 'RESOLVED_LANGUAGE']) {
    assert.ok(!source.includes(gone), `${gone} is gone from the job`);
  }
});

// ── Phase 6 refuses across owners ───────────────────────────────────────────

test('phase 6 refuses when the node and the project belong to different owners, and says so', async () => {
  const A = await makeOwner('sixa');
  const B = await makeOwner('sixb');
  const title = `Adopt the ${uuidv4().slice(0, 6)} importer`;
  const decidedAt = new Date(Date.now() - 86400000).toISOString();
  const PA = await makeProject(A, 'Own', { recent_decisions: [{ summary: title, decided_at: decidedAt }] });
  const PB = await makeProject(B, 'Other', { recent_decisions: [{ summary: title, decided_at: decidedAt }] });

  // A's resolved node, filed under B's project: the cross-account shape.
  await resolvedNode(A.orgId, PB, title);
  // And A's node under A's own project: the case that must still work.
  await resolvedNode(A.orgId, PA, title);
  const beforeB = await contextOf(B, PB);
  // Every cross-owner resolved node in the database, the way the job counts them.
  const { rows: [{ n: crossOwner }] } = await q(
    `SELECT count(*)::int AS n FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
     WHERE n.node_type = 'decision' AND n.metadata->>'status' = 'resolved' AND p.owner_key <> n.owner_key`,
    [],
  );
  assert.ok(crossOwner >= 1);

  const logs = await captured(() => vault.propagateResolvedDecisions());

  assert.deepEqual(await contextOf(B, PB), beforeB, 'the other owner\'s project was not written');
  assert.equal((await contextOf(B, PB)).context.recent_decisions[0].resolved, undefined);
  assert.equal((await contextOf(A, PA)).context.recent_decisions[0].resolved, true, 'a node applies to its own owner\'s project');

  const skipped = logs.map(([, line]) => line).find((line) => /skipped|refus/i.test(line) && line.includes('Phase 6'));
  assert.ok(skipped, `the skip is logged: ${JSON.stringify(logs)}`);
  assert.ok(skipped.includes(`skipped ${crossOwner} resolved`), `the log says how many nodes were skipped (${crossOwner}): ${skipped}`);
});

test('phase 6 refuses in both directions and when only the foreign node exists', async () => {
  const A = await makeOwner('sixc');
  const B = await makeOwner('sixd');
  const title = `Move the ${uuidv4().slice(0, 6)} queue to workers`;
  const decidedAt = new Date(Date.now() - 86400000).toISOString();
  const PA = await makeProject(A, 'A', { recent_decisions: [{ summary: title, decided_at: decidedAt }] });
  const PB = await makeProject(B, 'B', { recent_decisions: [{ summary: title, decided_at: decidedAt }] });
  await resolvedNode(A.orgId, PB, title);
  await resolvedNode(B.orgId, PA, title);
  const before = [await contextOf(A, PA), await contextOf(B, PB)];

  await captured(() => vault.propagateResolvedDecisions());

  assert.deepEqual([await contextOf(A, PA), await contextOf(B, PB)], before, 'neither project was written');
});

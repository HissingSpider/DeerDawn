/**
 * THE ONCE-PER-WORKSPACE BACKFILL, WHEN TWO PEOPLE ACCEPT AT ONCE.
 *
 * backfillProjectOwnership resolves an ambiguity that is only resolvable while a
 * workspace still has one member: a project with a NULL owner_user_id belongs to
 * the founder, and everything predating the team becomes 'personal' so inviting
 * a colleague does not publish it. It runs exactly once per workspace.
 *
 * "Exactly once" was enforced by an INSERT nobody else could win. That is sound
 * for two backfills racing and unsound for the moment it matters. Two accepts
 * milliseconds apart on the very FIRST 1->2 join interleave like this:
 *
 *   A inserts its membership row.
 *   B, now seeing two rows, concludes from hasEverHeldTwoMembers that this
 *     workspace predates the marker table and claims it as ALREADY DONE.
 *   A's claim returns false. The backfill never runs, ever.
 *
 * The pre-team projects keep visibility 'private' and a NULL author, and the
 * marker says it was handled. And because the marker was written BEFORE the flip
 * while the flip swallowed its own errors, a backfill that failed halfway was
 * recorded as complete too.
 *
 * The damaging window is only a couple of round trips wide, so the interleave is
 * swept rather than hoped for: the second accept is started at a range of lags
 * behind the first, on a fresh workspace each time. On the unfixed code the 2ms
 * offset reproduces it exactly (author NULL, visibility 'private', marker
 * written).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/workspace-backfill-race.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { hashPassword } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

// Must match WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE in workspaceService.
const LOCK_NAMESPACE = 0x44443032;

async function makeUser(label, orgId) {
  const userId = `user-${uuidv4()}`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  return userId;
}

/** A one-person workspace holding a project from before there was a team. */
async function soloWorkspaceWithHistory() {
  const orgId = `org-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, \'developer_pro\', \'developer_pro\', \'active\')',
    [orgId, 'race workspace'],
    orgId,
  );
  const founderId = await makeUser('founder', orgId);
  await workspace.ensureOwnerMembership(orgId, founderId);

  const projectId = `proj-${uuidv4()}`;
  await db.query(
    `INSERT INTO context_projects (project_id, owner_key, project_name, visibility, owner_user_id)
     VALUES ($1, $2, $3, 'private', NULL)`,
    [projectId, orgId, `Pre-team work ${uuidv4().slice(0, 5)}`],
    'org-system',
  );
  return { orgId, founderId, projectId };
}

async function cleanup(orgId) {
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
}

function projectRow(projectId) {
  return db.query(
    'SELECT visibility, owner_user_id FROM context_projects WHERE project_id = $1',
    [projectId],
    'org-system',
  ).then((r) => r.rows[0]);
}

test('two people accepting at the same instant do not lose the ownership backfill', async () => {
  // The damaging window is narrow: the second accept has to read
  // hasEverHeldTwoMembers AFTER the first has inserted its row and BEFORE the
  // first claims the marker. That is a couple of round trips wide, so it is
  // swept rather than guessed at, on a fresh workspace per offset.
  const offsets = [0, 1, 2, 3, 5, 8, 13, 21];
  const results = [];
  for (const lagMs of offsets) {
    const { orgId, founderId, projectId } = await soloWorkspaceWithHistory();
    const first = await makeUser('a', orgId);
    const second = await makeUser('b', orgId);
    try {
      const joins = [workspace.addMember(orgId, first, { role: 'member' })];
      if (lagMs) await new Promise((resolve) => setTimeout(resolve, lagMs));
      joins.push(workspace.addMember(orgId, second, { role: 'member' }));
      await Promise.all(joins);

      const row = await projectRow(projectId);
      const marker = await db.query(
        'SELECT COUNT(*)::int AS n FROM workspace_ownership_backfills WHERE owner_key = $1',
        [orgId],
        'org-system',
      );
      const members = await workspace.listMembers(orgId);
      results.push({
        lagMs,
        author: row.owner_user_id,
        visibility: row.visibility,
        markers: marker.rows[0].n,
        active: members.filter((m) => m.active).length,
        founderId,
      });
    } finally {
      await cleanup(orgId);
    }
  }

  for (const r of results) {
    assert.equal(
      r.author,
      r.founderId,
      `THE BUG (lag ${r.lagMs}ms): one joiner claimed the marker as "already done" and the other backed off, so the project kept a NULL author forever. ${JSON.stringify(results)}`,
    );
    assert.equal(
      r.visibility,
      'personal',
      `THE BUG (lag ${r.lagMs}ms): work predating the team stayed org-readable, which is what the flip exists to prevent`,
    );
    assert.equal(r.markers, 1, `the workspace is marked done exactly once (lag ${r.lagMs}ms)`);
    assert.equal(r.active, 3, `both joins still landed (lag ${r.lagMs}ms)`);
  }
});

test('joins to one workspace are serialised, and joins to another are not blocked', async () => {
  const first = await soloWorkspaceWithHistory();
  const second = await soloWorkspaceWithHistory();
  const joinerHere = await makeUser('here', first.orgId);
  const joinerThere = await makeUser('there', second.orgId);
  const gate = await db.pool.connect();
  try {
    await gate.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_NAMESPACE, first.orgId]);

    let blockedFinished = false;
    const blocked = workspace.addMember(first.orgId, joinerHere, { role: 'member' })
      .then((m) => { blockedFinished = true; return m; });

    // A different workspace must not wait behind this one: the lock is
    // per-workspace, not a global membership mutex.
    await workspace.addMember(second.orgId, joinerThere, { role: 'member' });
    assert.equal(blockedFinished, false, 'the join to the locked workspace must still be waiting');

    await gate.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, first.orgId]);
    await blocked;
    assert.equal(blockedFinished, true);
  } finally {
    await gate.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    gate.release();
    await cleanup(first.orgId);
    await cleanup(second.orgId);
  }
});

test('a workspace that regrows is not backfilled a second time', async () => {
  // The guarantee PR #504 added, re-pinned: the marker still has to survive the
  // transaction rework, or a departed engineer's org-owned project becomes his
  // alone the day a replacement is hired.
  const { orgId, founderId, projectId } = await soloWorkspaceWithHistory();
  try {
    const leaver = await makeUser('leaver', orgId);
    await workspace.addMember(orgId, leaver, { role: 'member' });
    assert.equal((await projectRow(projectId)).visibility, 'personal', 'the first join flips pre-team history');

    // A project the team owns together, created after the team existed.
    const teamProject = `proj-${uuidv4()}`;
    await db.query(
      `INSERT INTO context_projects (project_id, owner_key, project_name, visibility, owner_user_id)
       VALUES ($1, $2, $3, 'private', $4)`,
      [teamProject, orgId, `Team work ${uuidv4().slice(0, 5)}`, leaver],
      'org-system',
    );

    await workspace.removeMember(orgId, leaver);
    const replacement = await makeUser('replacement', orgId);
    await workspace.addMember(orgId, replacement, { role: 'member' });

    const row = await projectRow(teamProject);
    assert.equal(row.visibility, 'private', 'org-owned work must stay org-owned when the team regrows');
    assert.equal(row.owner_user_id, leaver);
    assert.equal((await projectRow(projectId)).owner_user_id, founderId);
  } finally {
    await cleanup(orgId);
  }
});

test('a failed flip leaves the marker unclaimed, so the next join retries', async () => {
  // The marker used to be written BEFORE the flip, and the flip swallowed its
  // own errors: a backfill that could not complete was recorded as complete and
  // could never happen. Forced here by holding a row lock the flip needs, with a
  // statement timeout so the join fails rather than hanging.
  const { orgId, founderId, projectId } = await soloWorkspaceWithHistory();
  const blocker = await db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT project_id FROM context_projects WHERE project_id = $1 FOR UPDATE', [projectId]);

    const joiner = await makeUser('joiner', orgId);
    const previousTimeout = process.env.DB_STATEMENT_TIMEOUT;
    let failed = false;
    try {
      // The pool's own statement_timeout applies; the row lock outlives it.
      await workspace.addMember(orgId, joiner, { role: 'member' });
    } catch {
      failed = true;
    } finally {
      if (previousTimeout === undefined) delete process.env.DB_STATEMENT_TIMEOUT;
      else process.env.DB_STATEMENT_TIMEOUT = previousTimeout;
    }
    assert.equal(failed, true, 'a flip that cannot run must not report success');

    await blocker.query('ROLLBACK');

    const marker = await db.query(
      'SELECT COUNT(*)::int AS n FROM workspace_ownership_backfills WHERE owner_key = $1',
      [orgId],
      'org-system',
    );
    assert.equal(marker.rows[0].n, 0,
      'THE BUG: the workspace was marked backfilled although nothing was flipped, permanently');

    // The retry is an ordinary second attempt at the same join.
    await workspace.addMember(orgId, joiner, { role: 'member' });
    const row = await projectRow(projectId);
    assert.equal(row.owner_user_id, founderId);
    assert.equal(row.visibility, 'personal');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await cleanup(orgId);
  }
});

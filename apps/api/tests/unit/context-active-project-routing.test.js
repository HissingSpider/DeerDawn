/**
 * Routing: an actor's active project must be THEIRS, and stable.
 *
 * With no working directory (every hosted/web surface — claude.ai, ChatGPT —
 * calls resolveActiveProject(actor, null)), resolution fell all the way through
 * to "the most recently updated project in the whole workspace". That is
 * re-evaluated on EVERY write, so a teammate touching their own project — or
 * the same person switching tools — silently redirected the next write into a
 * project the actor had never touched, and in the worst case into a colleague's
 * PERSONAL one, which the actor may not even read.
 *
 * The fallback order this pins:
 *   1. an explicit project_id (the callers' job, not this function's)
 *   2. the pin / session binding for this workspace
 *   3. a real location signal (linked path > same workspace > name)
 *   4. this PERSON's own most recently touched project
 *   5. nothing — never a project the actor did not touch
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/context-active-project-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-routing-alice-${RUN}`;
const BOB = `user-routing-bob-${RUN}`;

const alice = () => ({ org_id: ORG, id: ALICE });
const bob = () => ({ org_id: ORG, id: BOB });

let aliceProject;
let bobProject;
let bobPersonal;

async function touch(projectId) {
  // Move updated_at forward the way a real write does, without racing the clock.
  await db.query(
    'UPDATE context_projects SET updated_at = NOW() WHERE project_id = $1',
    [projectId],
    'org-system'
  );
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });

  aliceProject = await service.createProject(alice(), { project_name: `Alice Stream ${RUN}` });
  bobProject = await service.createProject(bob(), { project_name: `Bob Stream ${RUN}` });
  bobPersonal = await service.createProject(bob(), { project_name: `Bob Side Project ${RUN}` });
  const personalRow = await store.getProject(ORG, bobPersonal.project_id);
  await store.saveProject({ ...personalRow, visibility: 'personal' }, null);
});

test.after(async () => {
  try {
    await db.query('DELETE FROM context_workspace_pointers WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system');
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a teammate\'s write does not redirect the other person\'s active project', async () => {
  // Alice touches hers, then Bob touches his — Bob's is now the workspace's
  // most-recently-updated project. Alice's next hosted write must still be hers.
  await touch(aliceProject.project_id);
  await touch(bobProject.project_id);

  const active = await service.resolveActiveProject(alice(), null);
  assert.ok(active, 'Alice has a project of her own, so something must resolve');
  assert.equal(
    active.project_id,
    aliceProject.project_id,
    'Alice\'s active project followed Bob\'s write into his project'
  );
});

test('a colleague\'s PERSONAL project can never become somebody\'s active project', async () => {
  await touch(bobPersonal.project_id);
  const active = await service.resolveActiveProject(alice(), null);
  assert.notEqual(
    active?.project_id,
    bobPersonal.project_id,
    'Alice\'s writes were routed into a personal project she may not even read'
  );
  assert.equal(active?.project_id, aliceProject.project_id, 'and she still lands on her own');
});

test('the same person on another tool still resolves their own project', async () => {
  await touch(bobPersonal.project_id);
  const active = await service.resolveActiveProject(bob(), null);
  assert.ok(
    [bobProject.project_id, bobPersonal.project_id].includes(active?.project_id),
    'Bob\'s own most-recent project is still his own'
  );
});

test('the solo single-project case is untouched', async () => {
  const SOLO = `org-${crypto.randomUUID()}`;
  const soloActor = { org_id: SOLO, id: `user-routing-solo-${RUN}` };
  try {
    const only = await service.createProject(soloActor, { project_name: `Solo Only ${RUN}` });
    const active = await service.resolveActiveProject(soloActor, null);
    assert.equal(active?.project_id, only.project_id, 'a solo user with one project always resolves it');
  } finally {
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [SOLO], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [SOLO], 'org-system');
  }
});

test('a colleague\'s shared project becomes yours once you have worked in it', async () => {
  // Tier 5 keys on authorship, which alone would strand a teammate who only ever
  // CONTRIBUTES to projects somebody else created. Tier 4 is what makes that
  // person's work reachable: writing once with an explicit project_id binds their
  // session, and every later no-project_id call follows the binding.
  await touch(bobProject.project_id);
  await service.upsertSession(alice(), `sess-routing-alice-${RUN}`, {
    tool: 'chatgpt_web',
    surface_type: 'browser',
    project_id: bobProject.project_id,
    status: 'active',
  });
  // Alice's own project is the more recent row; the binding must still win.
  await touch(aliceProject.project_id);

  const active = await service.resolveActiveProject(alice(), null);
  assert.equal(
    active?.project_id,
    bobProject.project_id,
    'the session binding is where this person was actually working'
  );
  assert.equal(active?.match_kind, 'session');

  // And it is still a binding, not a new leak: Bob's PERSONAL project is not
  // reachable this way even if a row pointed at it.
  await service.upsertSession(alice(), `sess-routing-alice-${RUN}`, { project_id: null });
});

test('a legacy unattributed project stays reachable for the workspace', async () => {
  // owner_user_id NULL predates per-user attribution: it belongs to the
  // workspace, not to a person, and must not be orphaned by this scoping.
  const legacy = await service.createProject(alice(), { project_name: `Legacy Shared ${RUN}` });
  await db.query(
    'UPDATE context_projects SET owner_user_id = NULL WHERE project_id = $1',
    [legacy.project_id],
    'org-system'
  );
  await touch(legacy.project_id);
  const active = await service.resolveActiveProject(bob(), null);
  assert.equal(active?.project_id, legacy.project_id, 'an unattributed project is the workspace\'s to resolve');
});

// ─── The teammate who has authored nothing ───────────────────────────────────
//
// Everything above protects a person who HAS projects from being redirected by
// somebody else's activity. It said nothing about the person who has none: the
// invited teammate on their first hosted session resolved to null, got the
// workspace overview instead of a brief, and every call without a project_id
// threw. Their own workspace, freshly joined, below.

async function freshTeam(label) {
  const org = `org-${crypto.randomUUID()}`;
  const owner = { org_id: org, id: `user-routing-${label}-owner-${RUN}` };
  const invitee = { org_id: org, id: `user-routing-${label}-invitee-${RUN}` };
  await workspace.addMember(org, owner.id, { role: 'owner' });
  await workspace.addMember(org, invitee.id, { role: 'member' });
  const cleanup = async () => {
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [org], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [org], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [org], 'org-system').catch(() => {});
  };
  return { org, owner, invitee, cleanup };
}

async function setVisibility(org, projectId, visibility) {
  const row = await store.getProject(org, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

test('an invited teammate who has authored nothing opens the most recent SHARED project', async () => {
  const team = await freshTeam('invitee');
  try {
    const older = await service.createProject(team.owner, { project_name: `Team Older ${RUN}` });
    const newer = await service.createProject(team.owner, { project_name: `Team Newer ${RUN}` });
    await setVisibility(team.org, older.project_id, 'shared');
    await setVisibility(team.org, newer.project_id, 'shared');
    await touch(newer.project_id);

    const active = await service.resolveActiveProject(team.invitee, null);
    assert.equal(
      active?.project_id,
      newer.project_id,
      'THE BUG: a teammate with no project of their own got no active project at all'
    );
    assert.equal(active?.match_kind, 'shared_fallback');
  } finally {
    await team.cleanup();
  }
});

test('the shared fallback never reaches a private or personal project', async () => {
  const team = await freshTeam('private');
  try {
    // The invitee is made an OWNER here on purpose: an owner can READ a
    // colleague's `private` project, so it is in their candidate set. Readable is
    // not "offered to the team", and it must not become their active project.
    await workspace.addMember(team.org, team.invitee.id, { role: 'owner' });
    const priv = await service.createProject(team.owner, { project_name: `Team Private ${RUN}` });
    const personal = await service.createProject(team.owner, { project_name: `Team Personal ${RUN}` });
    await setVisibility(team.org, priv.project_id, 'private');
    await setVisibility(team.org, personal.project_id, 'personal');
    await touch(priv.project_id);

    const active = await service.resolveActiveProject(team.invitee, null);
    assert.equal(active, null, `resolved ${active?.project_name}: a project nobody shared became somebody's write target`);
  } finally {
    await team.cleanup();
  }
});

test('the shared fallback does not apply to somebody who has a project of their own', async () => {
  const team = await freshTeam('hasown');
  try {
    const own = await service.createProject(team.invitee, { project_name: `Invitee Own ${RUN}` });
    const shared = await service.createProject(team.owner, { project_name: `Team Shared ${RUN}` });
    await setVisibility(team.org, shared.project_id, 'shared');
    await touch(shared.project_id);

    const active = await service.resolveActiveProject(team.invitee, null);
    assert.equal(active?.project_id, own.project_id, 'a teammate\'s activity redirected a person who has their own project');
  } finally {
    await team.cleanup();
  }
});

test('a project you just created beats a binding to the project you wrote to before', async () => {
  const team = await freshTeam('created');
  try {
    const before = await service.createProject(team.owner, { project_name: `Owner Before ${RUN}` });
    await service.upsertSession(team.owner, `sess-routing-created-${RUN}`, {
      tool: 'claude_web',
      surface_type: 'browser',
      project_id: before.project_id,
      status: 'active',
    });
    // The binding's last_seen_at is in the past relative to the new project.
    await db.query(
      'UPDATE context_sessions SET last_seen_at = NOW() - INTERVAL \'1 hour\' WHERE session_id = $1',
      [`sess-routing-created-${RUN}`],
      'org-system'
    );
    const created = await service.createProject(team.owner, { project_name: `Owner Just Created ${RUN}` });

    const active = await service.resolveActiveProject(team.owner, null);
    assert.equal(
      active?.project_id,
      created.project_id,
      'THE BUG: "create a project, then save" landed the save in the previously bound project'
    );
  } finally {
    await team.cleanup();
  }
});

test('a project created while this session is active does not steal its id-less writes', async () => {
  // The counterpart to the test above, and the half it was missing. The rule
  // reads "created since the binding was last seen", and the hosted dispatcher
  // refreshed last_seen_at on ONE tool (update_context with a summary), so for
  // every other write the condition stayed true indefinitely — and it fires for
  // ANY creation path. A person working in P1 who makes P2 in the dashboard for
  // later had their next id-less manage_tasks and record_finding land in the
  // empty P2, which is the same "reported success, wrong place" failure the
  // read-back checks exist to stop.
  const team = await freshTeam('midsession');
  try {
    const working = await service.createProject(team.owner, { project_name: `Owner Working ${RUN}` });
    await service.upsertSession(team.owner, `sess-routing-midsession-${RUN}`, {
      tool: 'claude_web',
      surface_type: 'browser',
      project_id: working.project_id,
      status: 'active',
    });
    // No interval rewind: the session was seen just now, which is what makes
    // this a side project rather than a switch.
    const later = await service.createProject(team.owner, { project_name: `Owner For Later ${RUN}` });

    const active = await service.resolveActiveProject(team.owner, null);
    assert.equal(
      active?.project_id,
      working.project_id,
      'THE BUG: a project created for later stole the writes of the session already in progress'
    );
    assert.equal(active?.match_kind, 'session');
    assert.ok(later.project_id);
  } finally {
    await team.cleanup();
  }
});

test('a project created long after the session went quiet still wins the binding', async () => {
  // The #494 case, restated as the boundary: what the rule is for is "create a
  // project, then save to it", which happens when the binding is from before.
  const team = await freshTeam('quiet');
  try {
    const before = await service.createProject(team.owner, { project_name: `Owner Quiet Before ${RUN}` });
    await service.upsertSession(team.owner, `sess-routing-quiet-${RUN}`, {
      tool: 'claude_web',
      surface_type: 'browser',
      project_id: before.project_id,
      status: 'active',
    });
    await db.query(
      'UPDATE context_sessions SET last_seen_at = NOW() - INTERVAL \'2 hours\' WHERE session_id = $1',
      [`sess-routing-quiet-${RUN}`],
      'org-system'
    );
    const created = await service.createProject(team.owner, { project_name: `Owner Quiet After ${RUN}` });

    const active = await service.resolveActiveProject(team.owner, null);
    assert.equal(active?.project_id, created.project_id);
  } finally {
    await team.cleanup();
  }
});

test('a project created days ago does not outrank the binding forever', async () => {
  // created_at > last_seen_at is also true for a dormant session, and there the
  // binding is the better guess: "I just made this" has an expiry.
  const team = await freshTeam('dormant');
  try {
    const bound = await service.createProject(team.owner, { project_name: `Owner Dormant Bound ${RUN}` });
    const old = await service.createProject(team.owner, { project_name: `Owner Dormant Old ${RUN}` });
    await db.query(
      'UPDATE context_projects SET created_at = NOW() - INTERVAL \'3 days\', updated_at = NOW() - INTERVAL \'3 days\' WHERE project_id = $1',
      [old.project_id],
      'org-system'
    );
    await service.upsertSession(team.owner, `sess-routing-dormant-${RUN}`, {
      tool: 'claude_web',
      surface_type: 'browser',
      project_id: bound.project_id,
      status: 'active',
    });
    await db.query(
      'UPDATE context_sessions SET last_seen_at = NOW() - INTERVAL \'10 days\' WHERE session_id = $1',
      [`sess-routing-dormant-${RUN}`],
      'org-system'
    );

    const active = await service.resolveActiveProject(team.owner, null);
    assert.equal(active?.project_id, bound.project_id);
    assert.equal(active?.match_kind, 'session');
  } finally {
    await team.cleanup();
  }
});

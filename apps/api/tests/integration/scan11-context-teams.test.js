/**
 * Scan 11 (2026-09-22), context API x teams. Each test pins one defect with the
 * request that exposed it:
 *
 *   #1 HIGH  a team VIEWER's dashboard session could PATCH /preferences (pausing
 *            every teammate's brief) and /global (rewriting the team profile).
 *            Session scopes come from users.role, so they carry context:write;
 *            only the workspace role can refuse it.
 *   #2 HIGH  entitlements follow the WORKSPACE, but skills, share links and
 *            cross-project decisions read the person's own (Free) org.
 *   #3 HIGH  GET /audit filtered on owner_key only: every member and viewer read
 *            colleagues' personal/private project activity, names and emails.
 *   #4 LOW   GET /stream forwarded every workspace message unfiltered.
 *   #5 LOW   the activity digest and product-event summary read the person's own
 *            org while the events are filed under the workspace.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan11-context-teams.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);

const db = require('../../src/config/db');
const { generateApiKey, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const contextRoutes = require('../../src/routes/context/context-sync');

const created = { orgs: new Set(), users: new Set() };

test.after(async () => {
  for (const orgId of created.orgs) {
    for (const sql of [
      'DELETE FROM context_audit_logs WHERE owner_key = $1',
      'DELETE FROM context_projects WHERE owner_key = $1',
      'DELETE FROM workspace_members WHERE owner_key = $1',
      'DELETE FROM workspace_invites WHERE owner_key = $1',
    ]) await db.query(sql, [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
  }
  await new Promise((resolve) => httpServer.close(resolve));
  const { closeRedisConnections } = require('../../src/config/redis');
  await closeRedisConnections().catch(() => {});
  await db.pool.end().catch(() => {});
});

// A separate org per person, always: the org plan cache holds for 300s, so two
// tests sharing an org would read each other's plan.
async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan11.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5], orgId,
  );
  // role 'admin' is what nearly every real account carries — and it is what
  // makes a session's scopes include context:write regardless of workspace role.
  await db.query(
    'INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)',
    [userId, email, 'admin', orgId], orgId,
  );
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  created.orgs.add(orgId);
  created.users.add(userId);
  return { label, orgId, userId, email, apiKey: key, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

// Dashboard session (bearer JWT) or API key, bound to a workspace by header.
function as(method, path, person, { ws = null, key = false } = {}) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${key ? person.apiKey : person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, { ws, key: true })
    .send({ project_name: `${name} ${uuidv4().slice(0, 6)}`, current_task: `${name} task` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function setVisibility(projectId, visibility) {
  await db.query('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', [visibility, projectId], 'org-system');
}

async function audit(ownerKey, { projectId = null, action, actor, metadata = {}, at = null }) {
  const id = `audit_${uuidv4()}`;
  await db.query(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata, created_at)
     VALUES ($1, $2, $3, $4, 'user', $5, 'dashboard', $6, COALESCE($7::timestamptz, NOW()))`,
    [id, ownerKey, projectId, action, actor.userId, metadata, at],
    'org-system',
  );
  return id;
}

// ── #1 ──────────────────────────────────────────────────────────────────────

test('#1 a team viewer\'s dashboard session cannot rewrite workspace preferences or global context', async () => {
  const owner = await makePerson('prefowner', { plan: 'developer_pro' });
  const viewer = await makePerson('prefviewer');
  const member = await makePerson('prefmember');
  await join(owner, viewer, 'viewer');
  await join(owner, member, 'member');

  const prefs = await as('patch', '/api/v1/context/preferences', viewer, { ws: owner.orgId })
    .send({ paused: true, security: { excluded_fields: ['recent_decisions'] } });
  assert.equal(prefs.status, 403, `viewer PATCH /preferences: ${prefs.status} ${JSON.stringify(prefs.body)}`);
  assert.equal(prefs.body.error, 'share_write_forbidden');

  const glob = await as('patch', '/api/v1/context/global', viewer, { ws: owner.orgId })
    .send({ user_profile: 'the viewer rewrote everyone\'s profile' });
  assert.equal(glob.status, 403, `viewer PATCH /global: ${glob.status} ${JSON.stringify(glob.body)}`);
  assert.equal(glob.body.error, 'share_write_forbidden');

  // Nothing landed for the owner.
  const ownerPrefs = await as('get', '/api/v1/context/preferences', owner, { key: true });
  assert.notEqual(ownerPrefs.body.preferences?.paused, true, 'the owner\'s briefs must not have been paused');
  assert.ok(!(ownerPrefs.body.preferences?.security?.excluded_fields || []).includes('recent_decisions'));
  const ownerGlobal = await as('get', '/api/v1/context/global', owner, { key: true });
  assert.notEqual(ownerGlobal.body.global?.user_profile, 'the viewer rewrote everyone\'s profile');

  // Control: a member still may, and so does the owner.
  const memberGlob = await as('patch', '/api/v1/context/global', member, { ws: owner.orgId })
    .send({ user_profile: 'member profile' });
  assert.equal(memberGlob.status, 200, JSON.stringify(memberGlob.body));
  const ownerPatch = await as('patch', '/api/v1/context/preferences', owner, { key: true }).send({ paused: false });
  assert.equal(ownerPatch.status, 200, JSON.stringify(ownerPatch.body));
});

test('#1 control: a solo account still writes its own preferences and global context', async () => {
  const solo = await makePerson('prefsolo');
  const prefs = await as('patch', '/api/v1/context/preferences', solo).send({ paused: true });
  assert.equal(prefs.status, 200, JSON.stringify(prefs.body));
  assert.equal(prefs.body.preferences.paused, true);
  const glob = await as('patch', '/api/v1/context/global', solo, { key: true }).send({ user_profile: 'solo' });
  assert.equal(glob.status, 200, JSON.stringify(glob.body));
});

// ── #2 ──────────────────────────────────────────────────────────────────────

const skillBody = (who) => ({
  name: `Scan11 skill ${who} ${uuidv4().slice(0, 6)}`,
  description: 'How we run migrations in this repo',
  markdown_content: '# Migrations\n\nRun make migrate, then verify the index list before deploying.',
});

test('#2 a member of a paid Team is governed by the Team plan, not their personal Free org', async () => {
  const owner = await makePerson('entowner', { plan: 'developer_pro' });
  const member = await makePerson('entmember'); // personal org on free
  await join(owner, member, 'member');

  const skill = await as('post', '/api/v1/context/skills', member, { ws: owner.orgId }).send(skillBody('member'));
  assert.equal(skill.status, 200, `member POST /skills in a paid Team: ${skill.status} ${JSON.stringify(skill.body)}`);

  // The import route gates on the same entitlement BEFORE its network fetch, so
  // a bad URL reaching the fetch (4xx other than the quota block) proves the gate passed.
  const imported = await as('post', '/api/v1/context/skills/import-github', member, { ws: owner.orgId })
    .send({ repo_url: 'not-a-github-url' });
  assert.notEqual(imported.body?.error, 'skills_limit_exceeded',
    `member import-github in a paid Team: ${imported.status} ${JSON.stringify(imported.body)}`);

  const projectId = await createProject(member, owner.orgId, 'Member project');
  const share = await as('post', `/api/v1/context/projects/${projectId}/share`, member, { ws: owner.orgId })
    .send({ visibility: 'unlisted', acknowledged_finding_ids: [] });
  assert.notEqual(share.body?.error, 'share_requires_upgrade',
    `member share in a paid Team: ${share.status} ${JSON.stringify(share.body)}`);
  assert.notEqual(share.status, 403);

  const portfolio = await as('get', '/api/v1/context/portfolio', member, { ws: owner.orgId });
  assert.equal(portfolio.status, 200, JSON.stringify(portfolio.body));
  assert.equal(portfolio.body.locked, false, 'control: the portfolio already follows the workspace');

  const cross = require('../../src/services/crossProjectService');
  const actor = { type: 'user', id: member.userId, org_id: member.orgId, workspace_key: owner.orgId, role: 'admin', scopes: ['context:read'] };
  const now = new Date().toISOString();
  const mk = (id, name, decision) => ({
    project_id: id, project_name: name, owner_key: owner.orgId, visibility: 'shared', owner_user_id: owner.userId,
    context: { current_task: 'Adopt advisory locks', recent_decisions: [{ summary: decision, decided_at: now }] },
  });
  const related = await cross.getRelatedFromOtherProjects(actor, {
    projectId: 'p-a',
    projects: [
      mk('p-a', 'Alpha', 'Serialise workspace membership changes with postgres advisory locks'),
      mk('p-b', 'Beta', 'Use postgres advisory locks to serialise membership changes in the invite flow'),
    ],
  });
  assert.equal(related.locked, false, 'cross-project must agree with the portfolio on who is unlocked');
});

test('#2 control: a solo Free account is still gated on its own plan', async () => {
  const solo = await makePerson('entsolo');
  const skill = await as('post', '/api/v1/context/skills', solo).send(skillBody('solo'));
  assert.equal(skill.status, 422);
  assert.equal(skill.body.error, 'skills_limit_exceeded');

  const projectId = await createProject(solo, null, 'Solo project');
  const share = await as('post', `/api/v1/context/projects/${projectId}/share`, solo)
    .send({ visibility: 'unlisted', acknowledged_finding_ids: [] });
  assert.equal(share.status, 403, JSON.stringify(share.body));
  assert.equal(share.body.error, 'share_requires_upgrade');
});

// ── #3 ──────────────────────────────────────────────────────────────────────

test('#3 the audit log shows a reader only the projects they may read, plus their own actions', async () => {
  const owner = await makePerson('audowner', { plan: 'developer_pro' });
  const author = await makePerson('audauthor');
  const viewer = await makePerson('audviewer');
  await join(owner, author, 'member');
  await join(owner, viewer, 'viewer');
  const ws = owner.orgId;

  const personal = await createProject(author, ws, 'Author personal');
  const priv = await createProject(author, ws, 'Author private');
  const shared = await createProject(author, ws, 'Author shared');
  await setVisibility(personal, 'personal');
  await setVisibility(priv, 'private');
  await setVisibility(shared, 'shared');

  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = {
    personal: await audit(ws, { projectId: personal, action: 'project_renamed', actor: author, at: old }),
    private: await audit(ws, { projectId: priv, action: 'project_renamed', actor: author }),
    shared: await audit(ws, { projectId: shared, action: 'project_renamed', actor: author }),
    // project_deleted names the project in metadata; the project is gone.
    deleted: await audit(ws, {
      projectId: `proj-${uuidv4()}`, action: 'project_deleted', actor: author,
      metadata: { project_name: 'Author secret side project' },
    }),
    // Team rows file the project under metadata.project_id with a NULL column.
    moved: await audit(ws, {
      action: 'project_moved', actor: author, metadata: { project_id: personal, name: 'Author personal', from: author.orgId },
    }),
    workspaceLevel: await audit(ws, { action: 'member_invited', actor: owner, metadata: { role: 'viewer' } }),
  };

  const idsFor = async (person, query = '') => {
    const res = await as('get', `/api/v1/context/audit?limit=100${query}`, person, { ws });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { ids: new Set(res.body.logs.map((row) => row.id)), body: res.body };
  };

  const v = await idsFor(viewer);
  assert.ok(v.ids.has(rows.shared), 'viewer sees the shared project\'s row');
  assert.ok(v.ids.has(rows.workspaceLevel), 'viewer sees workspace-level rows');
  for (const hidden of ['personal', 'private', 'deleted', 'moved']) {
    assert.ok(!v.ids.has(rows[hidden]), `viewer must not see the ${hidden} row`);
  }
  assert.ok(!JSON.stringify(v.body.logs).includes('Author secret side project'));
  assert.ok(new Date(v.body.retained_since) > new Date(old),
    'retained_since must not reveal the timestamp of a row the reader cannot see');

  const personalFilter = await as('get', `/api/v1/context/audit?project_id=${personal}`, viewer, { ws });
  assert.equal(personalFilter.status, 404, `viewer ?project_id=<personal>: ${personalFilter.status} ${JSON.stringify(personalFilter.body)}`);
  const sharedFilter = await as('get', `/api/v1/context/audit?project_id=${shared}`, viewer, { ws });
  assert.equal(sharedFilter.status, 200);
  assert.deepEqual(sharedFilter.body.logs.map((row) => row.id), [rows.shared]);

  // A workspace owner reads org-owned private work, never somebody's personal work.
  const o = await idsFor(owner);
  assert.ok(o.ids.has(rows.private) && o.ids.has(rows.shared) && o.ids.has(rows.workspaceLevel));
  for (const hidden of ['personal', 'deleted', 'moved']) {
    assert.ok(!o.ids.has(rows[hidden]), `owner must not see the author's ${hidden} row`);
  }

  // The author sees every row they wrote.
  const a = await idsFor(author);
  for (const key of Object.keys(rows)) assert.ok(a.ids.has(rows[key]), `author sees their own ${key} row`);
  const ownFilter = await as('get', `/api/v1/context/audit?project_id=${personal}`, author, { ws });
  assert.equal(ownFilter.status, 200);
});

test('#3 control: a solo account sees its whole audit log, deleted projects included', async () => {
  const solo = await makePerson('audsolo');
  const projectId = await createProject(solo, null, 'Solo audited');
  const mine = [
    await audit(solo.orgId, { projectId, action: 'project_renamed', actor: solo }),
    await audit(solo.orgId, { projectId: `proj-${uuidv4()}`, action: 'project_deleted', actor: solo, metadata: { project_name: 'gone' } }),
    await audit(solo.orgId, { action: 'workspace_created', actor: solo }),
  ];
  const res = await as('get', '/api/v1/context/audit', solo);
  assert.equal(res.status, 200);
  const ids = new Set(res.body.logs.map((row) => row.id));
  for (const id of mine) assert.ok(ids.has(id));
  const unknown = await as('get', `/api/v1/context/audit?project_id=proj-${uuidv4()}`, solo);
  assert.equal(unknown.status, 200, 'a solo account keeps today\'s behaviour: an empty page, not a 404');
});

// ── #4 ──────────────────────────────────────────────────────────────────────
// The stream's Redis branch never runs under NODE_ENV=test (redisDisabled), so
// the per-message filter it uses is pinned directly.

test('#4 the stream filter drops a colleague\'s personal project and passes what the reader may open', async () => {
  const owner = await makePerson('sseowner', { plan: 'developer_pro' });
  const viewer = await makePerson('sseviewer');
  await join(owner, viewer, 'viewer');
  const personal = await createProject(owner, owner.orgId, 'Owner side project');
  const shared = await createProject(owner, owner.orgId, 'Owner team project');
  await setVisibility(personal, 'personal');
  await setVisibility(shared, 'shared');

  assert.equal(typeof contextRoutes.createStreamProjectFilter, 'function');
  const viewerActor = { type: 'user', id: viewer.userId, org_id: viewer.orgId, workspace_key: owner.orgId, role: 'admin', scopes: [] };
  const mayForward = contextRoutes.createStreamProjectFilter(viewerActor, owner.orgId);
  assert.equal(await mayForward(personal), false, 'a colleague\'s personal project must not be announced');
  assert.equal(await mayForward(shared), true);
  assert.equal(await mayForward(null), true, 'a message about no project passes');

  // Evaluated per message: a project shared later passes, and one flipped to
  // personal is dropped from the very next message (the scanner's repro).
  const later = await createProject(owner, owner.orgId, 'Owner later project');
  await setVisibility(later, 'shared');
  assert.equal(await mayForward(later), true);
  await setVisibility(later, 'personal');
  assert.equal(await mayForward(later), false, 'no stale "visible" answer after a flip to personal');

  // The author streams their own personal project.
  const ownerActor = { type: 'user', id: owner.userId, org_id: owner.orgId, role: 'admin', scopes: [] };
  assert.equal(await contextRoutes.createStreamProjectFilter(ownerActor, owner.orgId)(personal), true);
});

// ── #5 ──────────────────────────────────────────────────────────────────────

test('#5 the digest and the event summary read the workspace the events were filed under', async () => {
  const owner = await makePerson('digowner', { plan: 'developer_pro' });
  const mate = await makePerson('digmate');
  await join(owner, mate, 'member');

  const pe = require('../../src/services/productEventsService');
  const digest = require('../../src/services/activityDigestService');
  const mateInTeam = { type: 'user', id: mate.userId, org_id: mate.orgId, workspace_key: owner.orgId, role: 'admin', scopes: [] };
  for (let i = 0; i < 3; i += 1) {
    await pe.recordProductEvent(mateInTeam, { event_name: 'context_delivered', source: 'context_sync', surface: 'claude_code' });
  }

  const mateView = await digest.computeWorkspaceActivity(mateInTeam, 7);
  const ownerView = await digest.computeWorkspaceActivity({ type: 'user', id: owner.userId, org_id: owner.orgId, role: 'admin', scopes: [] }, 7);
  assert.equal(ownerView.context_delivered, 3, 'control: the owner panel counts the teammate\'s deliveries');
  assert.equal(mateView.context_delivered, ownerView.context_delivered,
    'two people looking at the same workspace panel must see the same count');

  const summary = await pe.getProductEventSummary(mateInTeam);
  assert.equal(summary.totals.total_events, 3, 'the summary reads the workspace the events were filed under');
  assert.equal(summary.recent.length, 3, 'the reader\'s own events are listed');

  // On a shared workspace the recent list (paths + metadata) is the reader's own.
  const ownerSummary = await pe.getProductEventSummary({ type: 'user', id: owner.userId, org_id: owner.orgId, role: 'admin', scopes: [] });
  assert.equal(ownerSummary.totals.total_events, 3);
  assert.equal(ownerSummary.recent.length, 0, 'a colleague\'s recent events are not listed');
});

test('#5 control: a solo account\'s summary lists its own events as before', async () => {
  const solo = await makePerson('digsolo');
  const pe = require('../../src/services/productEventsService');
  const actor = { type: 'user', id: solo.userId, org_id: solo.orgId, role: 'admin', scopes: [] };
  await pe.recordProductEvent(actor, { event_name: 'context_delivered', source: 'context_sync', surface: 'codex' });
  const summary = await pe.getProductEventSummary(actor);
  assert.equal(summary.totals.total_events, 1);
  assert.equal(summary.recent.length, 1);
  assert.equal(await pe.getProductEventSummary({ type: 'user', id: 'nobody' }), null, 'no org, no summary');
});

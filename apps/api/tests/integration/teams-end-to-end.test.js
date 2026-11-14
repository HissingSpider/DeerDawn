/**
 * A two-person workspace, end to end, over the real HTTP API.
 *
 * Everything else in this branch is unit-level: it proves each control does what
 * it says in isolation. This proves the SHAPE — a second person joins a
 * workspace they were not signed up to, sees what is shared and not what is not,
 * contributes, and shows up by name in the first person's brief. That whole path
 * crosses membership, workspace binding, the visibility filter, the share
 * policy, attribution, and the catch-up renderer, and every one of those was
 * broken in a different way before this branch.
 *
 * The bugs it would have caught, each of which was real:
 *   • an invited teammate resolving to their own personal org and seeing nothing
 *   • private projects visible to everyone sharing an org
 *   • write permission answered by the org-level role, which is 'admin' for
 *     nearly everyone
 *   • contributions attributed to an API key rather than to a person
 *
 * MUTATION-TESTED, and the result is worth recording. Disabling the store-level
 * visibility filter alone does NOT fail this test, and neither does restoring
 * the ACL short-circuit alone — because the two are genuine defence in depth and
 * either one still holds the line by itself. Only disabling BOTH turns it red
 * ("a private project must NOT reach the teammate"). So this test verifies the
 * user-facing guarantee rather than any single layer, which is the right job for
 * it; the layers are pinned individually by tests/unit/teams-multi-user.test.js.
 *
 * Worth knowing before anyone "simplifies" one of those checks on the grounds
 * that the other covers it: that is true right up until the remaining one is
 * changed too, and this test is what would then be left holding the guarantee.
 *
 * DB-backed. Run: bash scripts/run-db-test.sh node --test tests/integration/teams-end-to-end.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const { closeRedisConnections } = require('../../src/config/redis');
const workspace = require('../../src/services/workspaceService');

/**
 * Two people who signed up SEPARATELY, each with their own org — which is the
 * situation that made invites impossible before this branch and the one every
 * real team starts from.
 */
async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  const expiresAt = new Date(Date.now() + 86400000).toISOString();

  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, prefix, hash, `${label} key`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
    orgId,
  );
  return { label, orgId, userId, email, apiKey: key };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

/** Act as this person, inside the given workspace. */
function as(req, person, workspaceKey) {
  const r = req.set('X-Api-Key', person.apiKey);
  return workspaceKey ? r.set('x-deerdawn-workspace', workspaceKey) : r;
}

test('a second person joins a workspace and the brief carries their work', async () => {
  // Sarah is on Team and owns the workspace; Marcus signed up separately on Free.
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const team = sarah.orgId;

  try {
    await workspace.addMember(team, sarah.userId, { role: 'owner' });

    // ── Sarah's own work, before anyone else arrives ──────────────────────
    const sharedRes = await as(request(httpServer).post('/api/v1/context/projects'), sarah)
      .send({ project_name: `Payments API ${uuidv4().slice(0, 6)}` });
    assert.equal(sharedRes.status, 201, JSON.stringify(sharedRes.body));
    const sharedId = sharedRes.body.project?.project_id || sharedRes.body.project_id;

    const privateRes = await as(request(httpServer).post('/api/v1/context/projects'), sarah)
      .send({ project_name: `Sarah private ${uuidv4().slice(0, 6)}` });
    const privateId = privateRes.body.project?.project_id || privateRes.body.project_id;

    // Both were made while the workspace was solo, so both are private — the
    // guarantee that inviting a colleague never publishes what predates them.
    await db.query(
      'UPDATE context_projects SET visibility = $2 WHERE project_id = $1',
      [sharedId, 'shared'], 'org-system',
    );

    // ── Marcus joins ─────────────────────────────────────────────────────
    // He already has an account. Before this branch that alone made him
    // un-invitable: users.email is unique and the invite INSERTed a user row.
    const invite = await workspace.createInvite(team, marcus.email, { role: 'member', invitedBy: sarah.userId });
    const accepted = await workspace.acceptInvite(invite.token, { id: marcus.userId, email: marcus.email });
    assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);

    // ── What Marcus can and cannot see ───────────────────────────────────
    const list = await as(request(httpServer).get('/api/v1/context/projects'), marcus, team);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const visible = (list.body.projects || []).map((p) => p.project_id);
    assert.ok(visible.includes(sharedId), 'a shared project must reach the teammate');
    assert.ok(!visible.includes(privateId), 'a private project must NOT reach the teammate');

    // Enumeration is a separate leak from access: the name alone is often the
    // client's name, so it must not appear even as a list entry.
    const names = JSON.stringify(list.body.projects || []);
    assert.ok(!names.includes('Sarah private'), 'a private project name must not leak into a listing');

    // ── Marcus contributes ───────────────────────────────────────────────
    const decision = 'Move the payments webhook retry budget to three attempts';
    const write = await as(request(httpServer).post('/api/v1/context/extraction'), marcus, team).send({
      session_id: `e2e-marcus-${uuidv4().slice(0, 8)}`,
      tool: 'cursor',
      session_context: { cwd: '/repo', host: 'marcus-laptop', status: 'active' },
      chunks: [{ role: 'assistant', text: decision }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.95,
        project_candidate: { project_id: sharedId, project_name: 'Payments API', reason: 'same repo' },
        delta: { recent_decisions: [{ summary: decision, decided_at: new Date().toISOString() }] },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });
    assert.ok(write.status === 200 || write.status === 202, JSON.stringify(write.body));

    // ── Attributed to the PERSON, not to the credential ──────────────────
    const stored = await db.query(
      'SELECT context FROM context_projects WHERE project_id = $1',
      [sharedId], 'org-system',
    );
    const raw = stored.rows[0]?.context;
    // Encrypted at rest when a master key is configured, so read it back through
    // the API rather than asserting on the column.
    assert.ok(raw, 'the project row still exists');

    const read = await as(
      request(httpServer).get(`/api/v1/context/projects/${sharedId}/inject?format=json`),
      sarah, team,
    );
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const entry = (read.body.context?.recent_decisions || []).find((d) => d.summary === decision);
    assert.ok(entry, 'the teammate\u2019s decision must be in the shared brief');
    assert.equal(
      entry.contributed_by, marcus.userId,
      'attribution must name the person, not the API key that carried the write',
    );

    // ── The roster reflects reality ──────────────────────────────────────
    const members = await workspace.listMembers(team);
    const ids = members.map((m) => m.user_id).sort();
    assert.deepEqual(ids, [sarah.userId, marcus.userId].sort(), 'both people are members');

    // ── Offboarding keeps the knowledge ──────────────────────────────────
    await workspace.removeMember(team, marcus.userId);
    const afterRemoval = await as(
      request(httpServer).get(`/api/v1/context/projects/${sharedId}/inject?format=json`),
      sarah, team,
    );
    const survives = (afterRemoval.body.context?.recent_decisions || []).find((d) => d.summary === decision);
    assert.ok(survives, 'a departed member\u2019s contributions must stay in the brief');
    assert.equal(survives.contributed_by, marcus.userId, 'and stay attributed to them');

    // ── And he can no longer reach the workspace ─────────────────────────
    const afterOut = await as(request(httpServer).get('/api/v1/context/projects'), marcus, team);
    assert.equal(afterOut.status, 403, 'a removed member must be refused, not quietly given their own workspace');

    // The same, for somebody whose users.org_id IS the workspace — the legacy
    // invite path creates users directly in the target org, and for them the
    // header is not needed to reach it. Removal has to revoke on that path too,
    // or it revokes nothing for exactly the population it was written for.
    // The sharper shape: somebody whose CREDENTIAL is scoped to the workspace, so
    // they never need the header to reach it. keys.js now mints keys against the
    // workspace the holder was operating in, and the legacy invite path creates
    // users directly in the target org — both produce this. defaultOwnerKey hands
    // back that workspace with no membership check, so removal revoked nothing
    // for exactly the population it was written for.
    const dana = await makePerson('dana');
    try {
      await db.query('UPDATE api_keys SET org_id = $1 WHERE owner_id = $2', [team, dana.userId], 'org-system');
      await workspace.addMember(team, dana.userId, { role: 'member' });
      const whileIn = await as(request(httpServer).get('/api/v1/context/projects'), dana);
      assert.equal(whileIn.status, 200, 'a member reaches the workspace their key is scoped to');

      await workspace.removeMember(team, dana.userId);
      const afterRemoval = await as(request(httpServer).get('/api/v1/context/projects'), dana);
      assert.equal(
        afterRemoval.status, 403,
        'a removed member must not keep access simply by omitting the workspace header',
      );
    } finally {
      await cleanup([dana]);
    }
    // ── A moved project's context must still be readable ─────────────────
    // The data key is per workspace, so moving the row without re-sealing leaves
    // ciphertext that fails its auth tag on the next read — and the fail-closed
    // path replaces the brief with a decrypt-error stub, permanently. Silent
    // data loss on the flagship onboarding step.
    const solo = await makePerson('solo');
    try {
      await workspace.addMember(solo.orgId, solo.userId, { role: 'owner' });
      const madeRes = await as(request(httpServer).post('/api/v1/context/projects'), solo)
        .send({ project_name: `Moves ${uuidv4().slice(0, 6)}` });
      const moveId = madeRes.body.project?.project_id || madeRes.body.project_id;
      const marker = 'The staging migration runner has to be run serially';
      await as(request(httpServer).patch(`/api/v1/context/projects/${moveId}/context`), solo)
        .send({ current_status: marker });

      await workspace.addMember(team, solo.userId, { role: 'member' });
      const movedRes = await as(request(httpServer).post(`/api/v1/teams/projects/${moveId}/move`), solo)
        .send({ workspace: team });
      assert.equal(movedRes.status, 200, JSON.stringify(movedRes.body));

      const reread = await as(
        request(httpServer).get(`/api/v1/context/projects/${moveId}/inject?format=json`),
        solo, team,
      );
      assert.equal(reread.status, 200, JSON.stringify(reread.body));
      assert.ok(
        !reread.body.context?._decrypt_error,
        'a moved project must still decrypt \u2014 its context was not re-sealed for the destination',
      );
      assert.equal(reread.body.context?.current_status, marker, 'and its brief must survive the move');
    } finally {
      await cleanup([solo]);
    }
  } finally {
    await cleanup([sarah, marcus]);
    await closeRedisConnections().catch(() => {});
    await db.pool.end().catch(() => {});
  }
});

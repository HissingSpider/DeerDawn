/**
 * JOURNEY R4 — THE RETENTION LINE COMES OUT OF EVERY BRIEF.
 *
 * Every shared project's brief — the text an assistant reads at session start,
 * and the dashboard's "What your AI reads" preview of it — carried
 *   "Shared workspace — N teammates have contributed this context; leaving
 *    DeerDawn loses the team's accumulated brief."
 * A retention pitch, addressed to nobody who can act on it, inside a tool
 * response. The owner's decision: remove it from what the assistant reads.
 * Nothing else in the brief changes: the fact before the semicolon stays.
 *
 * Every reader of a shared project (owner, member, viewer), every tool the
 * preview offers (the local server's /active renders the same body, from the
 * same renderInjection), and the hosted start_session.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-brief-retention-line.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrgUser(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  return { label, orgId, userId, email };
}

async function keyFor(person, workspaceKey) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${person.label} key`, person.userId, workspaceKey, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    workspaceKey,
  );
  return key;
}

async function cleanup(people, team) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await q(`DELETE FROM ${table} WHERE owner_key = $1`, [team]).catch(() => {});
  }
  await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [team]).catch(() => {});
  await q('DELETE FROM context_session_loads WHERE owner_key = $1', [team]).catch(() => {});
  await q('DELETE FROM context_sessions WHERE owner_key = $1', [team]).catch(() => {});
  await q('DELETE FROM context_projects WHERE owner_key = $1', [team]).catch(() => {});
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [team]).catch(() => {});
  for (const person of people) {
    await db.query('DELETE FROM product_events WHERE org_id = ANY($1)', [[person.orgId, team]], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE owner_id = $1', [person.userId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE user_id = $1', [person.userId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

function matched(projectId, delta) {
  return {
    match_decision: 'matched_existing', confidence: 0.95,
    project_candidate: { project_id: projectId, project_name: 'Team project' },
    delta, should_create_project: false, needs_user_confirmation: false,
  };
}

async function hostedText(key, name, args) {
  const res = await request(httpServer).post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', key)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

const RETENTION = /leaving DeerDawn|accumulated brief|loses the team/i;
const TEAM_LINE = 'Shared workspace — 2 teammates have contributed this context.';

test('no brief of a shared project carries the retention line, for any reader or tool', async () => {
  const owner = await makeOrgUser('owner');
  const member = await makeOrgUser('member');
  const viewer = await makeOrgUser('viewer');
  const team = owner.orgId;
  try {
    await workspace.addMember(team, owner.userId, { role: 'owner' });
    await workspace.addMember(team, member.userId, { role: 'member' });
    await workspace.addMember(team, viewer.userId, { role: 'viewer' });
    const keys = {
      owner: await keyFor(owner, team),
      member: await keyFor(member, team),
      viewer: await keyFor(viewer, team),
    };

    const created = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', keys.owner)
      .send({ project_name: `Team brief ${uuidv4().slice(0, 6)}`, description: 'the team project' });
    assert.equal(created.status, 201, created.text);
    const projectId = created.body.project.project_id;
    await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [projectId, 'shared']);

    // Two contributors: the owner and the member each capture something.
    for (const [who, status] of [['owner', 'Auth layer wired by the owner.'], ['member', 'Session store moved to Redis by the member.']]) {
      const res = await request(httpServer).post('/api/v1/context/extraction').set('X-Api-Key', keys[who]).send({
        session_id: `agent-${who}-${uuidv4().slice(0, 6)}`, tool: 'claude_code', project_id: projectId,
        chunks: [{ role: 'user', text: 'wrap up' }, { role: 'assistant', text: status }],
        extraction: matched(projectId, { current_status: status }),
      });
      assert.ok(res.status < 300, res.text);
    }

    const seen = [];
    for (const [who, key] of Object.entries(keys)) {
      // The dashboard's "What your AI reads" preview reads exactly this, per tool.
      for (const tool of ['claude_code', 'cursor', 'codex', 'chatgpt_web', 'claude_web']) {
        const res = await request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?tool=${tool}&verbosity=standard`).set('X-Api-Key', key);
        assert.equal(res.status, 200, `${who}/${tool}: ${res.text}`);
        seen.push([`${who} ${tool} preview`, res.body.payload?.body]);
      }
      seen.push([`${who} hosted start_session`, await hostedText(key, 'start_session', { project_id: projectId })]);
    }
    for (const [where, text] of seen) {
      assert.ok(!RETENTION.test(text), `THE BUG: the retention line is in the ${where}:\n${text}`);
      assert.ok(text.includes(TEAM_LINE), `the team line itself stays (${where}):\n${text}`);
    }
  } finally {
    await cleanup([owner, member, viewer], team);
  }
});

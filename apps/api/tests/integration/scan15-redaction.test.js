/**
 * Scan 15 (2026-09-23), REDACTION — the stored/served half, end to end. Each
 * test pins one defect with the request that exposed it:
 *
 *   #1 HIGH  round 14 narrowed the KEY secret name to a whitelist, so every other
 *            upper-snake *_KEY env secret (APP_KEY, ALGOLIA_ADMIN_KEY,
 *            MAILGUN_KEY, JWT_KEY, SECRET_KEY_BASE) was PERSISTED and SERVED
 *            verbatim. Now stored masked, and the PATCH says so.
 *   #2 MED   hosted manage_memory update compared its task read-back with the
 *            RAW words while the service stores them masked, so a task naming
 *            a key that had landed was reported "Current task NOT changed".
 *   #3 MED   PATCH computed `redacted` from the already-masked project, so the
 *            flag was never sent (pinned in scan14-honest-replies #1; the
 *            *_KEY write below asserts it too).
 *
 * Every secret is random per run and assembled by concatenation.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan15-redaction.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);

const db = require('../../src/config/db');
const { generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const created = { orgs: new Set() };

test.after(async () => {
  for (const orgId of created.orgs) {
    for (const sql of [
      'DELETE FROM context_audit_logs WHERE owner_key = $1',
      'DELETE FROM context_graph_evidence WHERE owner_key = $1',
      'DELETE FROM context_graph_edges WHERE owner_key = $1',
      'DELETE FROM context_graph_nodes WHERE owner_key = $1',
      'DELETE FROM context_sessions WHERE owner_key = $1',
      'DELETE FROM context_projects WHERE owner_key = $1',
      'DELETE FROM workspace_members WHERE owner_key = $1',
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

const GHP = `ghp_${uuidv4().replace(/-/g, '').slice(0, 36)}`;
const NEEDLE = GHP.slice(4);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan15.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'], orgId,
  );
  await db.query('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [userId, email, 'admin', orgId], orgId);
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
  return { label, orgId, userId, apiKey: key };
}

const rest = (method, path, person) => request(httpServer)[method](path).set('x-api-key', person.apiKey);

let rpcId = 1;
async function mcp(person, name, args = {}) {
  const res = await request(httpServer).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('x-api-key', person.apiKey)
    .send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body;
  if (!body || !Object.keys(body).length) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  const text = (body?.result?.content || []).map((c) => c.text).join('\n') || body?.error?.message || '';
  return { isError: Boolean(body?.error || body?.result?.isError), text, raw: JSON.stringify(body) };
}

async function createProject(person, name) {
  const res = await rest('post', '/api/v1/context/projects', person).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function brief(person, projectId) {
  const res = await rest('get', `/api/v1/context/projects/${projectId}/inject?format=json`, person);
  return res.body.context || res.body;
}

const rnd = () => uuidv4().replace(/-/g, '');

// ── #1 + #3 ─────────────────────────────────────────────────────────────────

test('#1 upper-snake *_KEY env lines are stored and served masked, and the PATCH flags it', async () => {
  const person = await makePerson('namedkey');
  const pid = await createProject(person, 'Named keys');
  const secrets = {
    laravel: Buffer.from(rnd()).toString('base64'),
    algolia: rnd(),
    mailgun: rnd(),
    jwt: `${rnd()}${rnd().slice(0, 8)}`,
    rails: `${rnd()}${rnd()}`,
  };
  const goals = [
    `APP_KEY=base64:${secrets.laravel}`,
    `ALGOLIA_ADMIN_KEY=${secrets.algolia}`,
    `MAILGUN_KEY=key-${secrets.mailgun}`,
    `JWT_KEY: ${secrets.jwt}`,
    `SECRET_KEY_BASE=${secrets.rails}`,
  ];
  const res = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ goals });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.redacted, true, 'the PATCH gave no sign the stored goals differ from the sent ones');
  assert.deepEqual(res.body.redacted_fields, ['goals']);

  const served = JSON.stringify(await brief(person, pid));
  const row = await db.query('SELECT context FROM context_projects WHERE project_id = $1', [pid], 'org-system');
  const stored = JSON.stringify(row.rows[0]);
  const leaked = Object.entries(secrets)
    .filter(([, v]) => served.includes(v) || stored.includes(v) || JSON.stringify(res.body).includes(v))
    .map(([k]) => k);
  assert.deepEqual(leaked, [], `stored/served verbatim: ${leaked.join(', ')}`);
  // The names survive: the brief still says WHICH key was there.
  for (const name of ['APP_KEY', 'ALGOLIA_ADMIN_KEY', 'MAILGUN_KEY', 'JWT_KEY', 'SECRET_KEY_BASE']) {
    assert.ok(served.includes(`${name}`), `${name} lost from the brief`);
  }
});

test('#1 lowercase design text around "key" is stored byte-identical, with no redacted flag', async () => {
  const person = await makePerson('keyprose');
  const pid = await createProject(person, 'Key prose');
  const goals = ['Partition key: tenant_id', 'cache_key: user:123', 'hotkey=ctrl+shift+k', 'SORT_KEY=created_at'];
  const res = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ goals });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.redacted, undefined);
  const after = await brief(person, pid);
  for (const g of goals) assert.ok((after.goals || []).includes(g), `rewritten: ${g} -> ${JSON.stringify(after.goals)}`);
});

// ── #2 ──────────────────────────────────────────────────────────────────────

test('#2 hosted manage_memory update: a task that landed masked is not reported NOT changed', async () => {
  const person = await makePerson('hostedtask');
  const pid = await createProject(person, 'Hosted task');
  const task = `Rotate the leaked token ${GHP} today`;

  const alone = await mcp(person, 'manage_memory', { action: 'update', project_id: pid, task });
  assert.equal(alone.isError, false, alone.text);
  assert.equal((await brief(person, pid)).current_task, 'Rotate the leaked token [REDACTED] today', 'the write DID land (masked)');
  assert.doesNotMatch(alone.text, /NOT changed/, alone.text);
  assert.match(alone.text, /written, with sensitive text redacted/, alone.text);
  assert.ok(!alone.raw.includes(NEEDLE), 'the reply echoed the key');

  const withSummary = await mcp(person, 'manage_memory', {
    action: 'update',
    project_id: pid,
    task,
    summary: 'Decision: rotate every credential that appeared in a transcript.',
  });
  assert.equal(withSummary.isError, false, withSummary.text);
  assert.doesNotMatch(withSummary.text, /NOT changed/, withSummary.text);
  assert.ok(!withSummary.raw.includes(NEEDLE), 'the reply echoed the key');
});

/**
 * JOURNEY R4 — THE BRIEF SHOWS THE NEWEST THREE DECISIONS, PLUS ANYTHING PINNED.
 *
 * The brief printed ONE decision, chosen by importance. By week two a project
 * that decided something every day opened each session on a month-old
 * "important" decision, and the one made yesterday was absent. The owner's
 * decision: the newest three, plus anything pinned; older ones stay
 * searchable. Both dispatchers and the dashboard's "What your AI reads"
 * preview read the same body (renderInjection), so they agree by
 * construction; this drives the hosted start_session and the preview for
 * every tool.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-brief-newest-decisions.test.js
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
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'],
  );
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId],
  );
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'key', userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { orgId, userId, apiKey: key };
}

async function cleanup(person) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await q(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId]).catch(() => {});
  }
  await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId]).catch(() => {});
  await q('DELETE FROM context_session_loads WHERE owner_key = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM product_events WHERE org_id = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM api_keys WHERE org_id = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM users WHERE org_id = $1', [person.orgId]).catch(() => {});
  await q('DELETE FROM organizations WHERE org_id = $1', [person.orgId]).catch(() => {});
}

async function hosted(person, name, args) {
  const res = await request(httpServer).post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', person.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

const at = (days) => new Date(Date.now() - days * 86400000).toISOString();

test('the brief a session opens on shows the newest three decisions and the pinned one, on every surface', async () => {
  const person = await makePerson('newest');
  try {
    const created = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Ledgerline ${uuidv4().slice(0, 6)}` });
    assert.equal(created.status, 201, created.text);
    const projectId = created.body.project.project_id;
    const patched = await request(httpServer).patch(`/api/v1/context/projects/${projectId}/context`).set('X-Api-Key', person.apiKey).send({
      current_task: 'Ship invoice exports',
      recent_decisions: [
        { summary: 'Decided Postgres is the only datastore.', decided_at: at(30), importance: 'high' },
        { summary: 'Decided exports are CSV first.', decided_at: at(20) },
        { summary: 'Decided to cap exports at 10k rows.', decided_at: at(3) },
        { summary: 'Decided the export button lives on the invoices page.', decided_at: at(2) },
        { summary: 'Decided to email a receipt after each export.', decided_at: at(1) },
      ],
    });
    assert.ok(patched.status < 300, patched.text);

    const WANT = 'Recent decisions: Decided to email a receipt after each export. | Decided the export button lives on the invoices page. | Decided to cap exports at 10k rows. | Decided Postgres is the only datastore. ★ important';
    const surfaces = [['hosted start_session', await hosted(person, 'start_session', { project_id: projectId })]];
    for (const tool of ['claude_code', 'cursor', 'codex', 'chatgpt_web', 'claude_web']) {
      const res = await request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?tool=${tool}&verbosity=standard`).set('X-Api-Key', person.apiKey);
      assert.equal(res.status, 200, res.text);
      surfaces.push([`${tool} preview`, res.body.payload?.body]);
    }
    for (const [where, text] of surfaces) {
      const line = String(text).split('\n').find((l) => l.startsWith('Recent decisions:'));
      assert.equal(line, WANT, `THE BUG (${where}): the brief does not show the newest three decisions plus the pinned one:\n${text}`);
    }

    // Older decisions stay searchable.
    const search = await hosted(person, 'recall', { action: 'search', query: 'CSV first' });
    assert.match(search, /Decided exports are CSV first\./, search);
  } finally {
    await cleanup(person);
  }
});

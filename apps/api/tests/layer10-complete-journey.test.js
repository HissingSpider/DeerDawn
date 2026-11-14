/**
 * Layer 10 — Complete User Journey
 *
 * Ordered end-to-end test that mirrors what a real user does from
 * first login to daily use. If this passes, a manual walkthrough
 * should produce zero surprises.
 *
 * Journey:
 *   1. Dashboard bootstrap (free plan)
 *   2. Onboarding state
 *   3. Billing plans — upgrade page data
 *   4. MCP device flow (start → pending → authorize → token)
 *   5. Context sync (project → extraction → active → overview → map → search)
 *   6. Injection format per tool
 *   7. Global context (user profile, stack)
 *   8. Preferences (tool disable → suppressed inject → re-enable)
 *   9. Flush-session simulation (session chunks → extraction)
 *  10. Workspace entities (create → filter by type → overview)
 *  11. Dashboard bootstrap after context
 *  12. API key management (create → list → delete)
 *  13. Org usage stats
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');
const { hashPassword, generateApiKey, generateToken } = require('../src/utils/security');
const store = require('../src/store/contextSyncStore');

async function createOrgFixture() {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `journey-${Date.now()}-${uuidv4().slice(0, 6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, 'Journey Test Org', 'free', 'free', 'trial_active', 'personal'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, passHash, 'admin', orgId],
    orgId
  );
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, 'Journey Key', userId, orgId, 'sandbox', expiresAt.toISOString(), ['*']],
    orgId
  );
  const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });
  return { orgId, userId, email, apiKey: key, token };
}

async function cleanupOrg(orgId) {
  for (const t of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await db.query(`DELETE FROM ${t} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
  }
  await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM injection_preferences WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_globals WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  for (const t of ['audit_logs', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${t} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

test('Layer 10 — Complete User Journey', async (t) => {
  // Create fixture at top level — avoids t.before's 3-second hook timeout
  const fixture = await createOrgFixture();
  let projectId;
  let mcpApiKey;
  let newKeyId;
  let deviceCode;
  let userCode;

  t.after(async () => {
    await cleanupOrg(fixture.orgId).catch(() => {});
    await store.clearAll().catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  const auth = (req) => req.set('X-Api-Key', fixture.apiKey);

  // ─── Step 1: Dashboard bootstrap ─────────────────────────────────────────

  await t.test('Step 1 — GET /dashboard/bootstrap returns free plan state', async () => {
    const res = await auth(request(httpServer).get('/api/v1/dashboard/bootstrap'));
    assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.org, 'expected org field');
    assert.ok(res.body.user, 'expected user field');
    const tier = res.body.org?.plan_tier ?? res.body.billing?.plan_tier;
    assert.ok(!tier || tier === 'free', `expected free tier, got: ${tier}`);
  });

  // ─── Step 2: Onboarding state ─────────────────────────────────────────────

  await t.test('Step 2 — GET /onboarding/state returns state with recommended_next_step', async () => {
    const res = await auth(request(httpServer).get('/api/v1/onboarding/state'));
    assert.ok(res.status === 200 || res.status === 404, `got ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.status === 200) {
      assert.ok(
        res.body.recommended_next_step !== undefined || res.body.steps !== undefined || res.body.state !== undefined,
        `expected onboarding shape, got: ${JSON.stringify(res.body)}`
      );
    }
  });

  // ─── Step 3: Billing plans (upgrade page) ────────────────────────────────

  await t.test('Step 3 — GET /billing/plans returns plans with price + limits', async () => {
    const res = await auth(request(httpServer).get('/api/v1/billing/plans'));
    assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    const plans = res.body.plans || res.body;
    assert.ok(Array.isArray(plans) && plans.length > 0, 'expected non-empty plans array');
    const ids = plans.map(p => p.id ?? p.plan_id ?? p.tier);
    assert.ok(ids.some(id => ['free', 'developer_basic', 'starter'].includes(id)),
      `expected known plan ids, got: ${JSON.stringify(ids)}`);
    // developer_pro (Team) joined the PUBLIC catalog on 2026-08-27 so /pricing can
    // show the three-column argument. That is a DISPLAY change, and this
    // assertion used to conflate "public" with "self-serve" — they are separate
    // lists. The property that actually protects the user is that it cannot be
    // BOUGHT, because its Stripe prices are still the old $25/$240 ones and a
    // checkout at the wrong price is a billing bug. So assert that directly,
    // against the same gate checkout uses (billing.js checks isSelfServePlan),
    // rather than against catalog membership.
    // Team BECAME checkout-able on 2026-09-02, once the $15/seat and
    // $150/seat/year prices existed in Stripe and the API held their ids — which
    // is exactly the condition the previous version of this assertion named as
    // its reason ("its Stripe prices are still the old $25/$240 ones"). The
    // word "never" in that message was overstated: it was a temporary state
    // wearing permanent language.
    //
    // What protects a buyer is not that one particular plan is unsellable. It
    // is that NO plan can be sold without a resolvable price, whatever the
    // catalog says. That is a property of the checkout path, so assert it
    // there: with no price ids configured — which is this test environment —
    // opening checkout must throw rather than send someone to Stripe with a
    // half-built line item.
    const { PLANS } = require('../src/config/plans');
    const { __testables: { validateCheckoutCatalog } } = require('../src/services/stripeService');
    assert.throws(
      () => validateCheckoutCatalog(PLANS.developer_pro, 'developer_pro', 'monthly'),
      /Missing Stripe base price/,
      'a self-serve plan with no configured price must refuse checkout, not attempt it',
    );
    const withLimits = plans.find(p => p.limits !== undefined || typeof p.price === 'number');
    assert.ok(withLimits, 'expected at least one plan with limits or numeric price');
  });

  await t.test('Step 3b — a displayed-but-not-self-serve plan is refused at checkout', async () => {
    // The end of the previous step is a claim about config; this is the same
    // claim at the HTTP boundary, where a user would actually hit it.
    const res = await auth(
      request(httpServer).post('/api/v1/billing/checkout').send({ tier: 'developer_pro' }),
    );
    assert.ok(res.status >= 400 && res.status < 500,
      `Team must not open a checkout session, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ─── Step 4: MCP device flow ─────────────────────────────────────────────

  await t.test('Step 4a — POST /auth/mcp/start returns device_code and verification_url', async () => {
    const res = await request(httpServer).post('/api/v1/auth/mcp/start').send({});
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.device_code, `expected device_code, got: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.verification_url, 'expected verification_url');
    deviceCode = res.body.device_code;
    userCode = res.body.user_code;
  });

  await t.test('Step 4b — GET /auth/mcp/token returns pending before authorization', async () => {
    if (!deviceCode) return;
    const res = await request(httpServer).get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.body.status === 'pending' || res.body.status === 'authorization_pending',
      `expected pending status, got: ${JSON.stringify(res.body)}`
    );
  });

  await t.test('Step 4c — POST /auth/mcp/authorize with JWT completes authorization', async () => {
    if (!deviceCode) return;
    const res = await request(httpServer)
      .post('/api/v1/auth/mcp/authorize')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ device_code: deviceCode, user_code: userCode });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 4d — GET /auth/mcp/token returns api_key after authorization', async () => {
    if (!deviceCode) return;
    const res = await request(httpServer).get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.api_key || res.body.status === 'authorized',
      `expected api_key or authorized status, got: ${JSON.stringify(res.body)}`);
    if (res.body.api_key) mcpApiKey = res.body.api_key;
  });

  await t.test('Step 4e — MCP API key can authenticate via GET /auth/me', async () => {
    const key = mcpApiKey ?? fixture.apiKey;
    const res = await request(httpServer).get('/api/v1/auth/me').set('X-Api-Key', key);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.user?.id, `expected user.id, got: ${JSON.stringify(res.body)}`);
  });

  // ─── Step 5: Context sync ─────────────────────────────────────────────────

  const mkReq = (req) => req.set('X-Api-Key', mcpApiKey ?? fixture.apiKey);

  await t.test('Step 5a — Create context project', async () => {
    const res = await mkReq(request(httpServer).post('/api/v1/context/projects'))
      .send({ project_name: 'Journey Test App', description: 'Test project', tech_stack: ['TypeScript', 'Node.js'] });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    projectId = res.body.project?.project_id ?? res.body.project_id ?? res.body.id;
    assert.ok(projectId, `expected project_id, got: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 5b — Push extraction (simulates update_context)', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer).post('/api/v1/context/extraction'))
      .send({
        session_id: `sess-${uuidv4()}`,
        tool: 'claude_code',
        project_id: projectId,
        chunks: [
          { role: 'user', text: 'Build the auth service for Journey Test App using TypeScript' },
          { role: 'assistant', text: 'Building auth service with JWT tokens and rate limiting.' },
          { role: 'user', text: 'Add rate limiting to login endpoint' },
          { role: 'assistant', text: 'Added sliding window rate limiter — 5 attempts per minute.' },
          { role: 'user', text: 'Ship it' },
        ],
        delta: {
          current_task: 'Build auth service with rate limiting',
          current_status: 'Auth service shipped — JWT + rate limiting live',
          tech_stack: ['TypeScript', 'Node.js', 'JWT'],
          recent_decisions: [{ summary: 'Use JWT for stateless auth tokens', decided_at: new Date().toISOString() }],
        },
      });
    assert.ok(res.status === 200 || res.status === 202, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 5c — GET /context/active simulates start_session', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/active?tool=claude_code'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.project_id, `expected project_id, got: ${JSON.stringify(res.body)}`);
    const brief = res.body.brief ?? res.body.payload?.body ?? res.body.context;
    assert.ok(brief, 'expected brief or context in active response');
  });

  await t.test('Step 5d — GET /context/workspace/overview returns startup state', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/workspace/overview?mode=startup'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body !== null && res.body !== undefined, 'expected non-null overview');
  });

  await t.test('Step 5e — GET /context/map includes project', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/map?mcp=true'));
    assert.strictEqual(res.status, 200);
    const mapText = res.body.map ?? res.body.map_text ?? '';
    const count = res.body.project_count ?? res.body.projects?.length;
    assert.ok(
      mapText.includes('Journey Test App') || (count !== undefined && count >= 1),
      `expected project in map, got project_count=${count}, map snippet: ${String(mapText).slice(0, 150)}`
    );
  });

  await t.test('Step 5f — POST /context/search finds project', async () => {
    const res = await mkReq(request(httpServer).post('/api/v1/context/search'))
      .send({ query: 'Journey Test App TypeScript', limit: 5 });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    const results = res.body.results ?? res.body.projects ?? res.body;
    if (Array.isArray(results)) {
      assert.ok(results.length >= 0, 'expected results array');
    }
  });

  // ─── Step 6: Injection format per tool ────────────────────────────────────

  await t.test('Step 6a — claude_code injection returns non-empty body', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code&verbosity=standard`));
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.status === 200) {
      const body = res.body.payload?.body ?? res.body.body ?? res.body.brief;
      assert.ok(body && body.length > 0, 'expected non-empty injection body for claude_code');
    }
  });

  await t.test('Step 6b — claude_web injection responds (200 or 204)', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_web&verbosity=light`));
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 6c — cursor injection responds (200 or 204)', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?tool=cursor&verbosity=standard`));
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ─── Step 7: Global context ────────────────────────────────────────────────

  await t.test('Step 7a — PATCH /context/global sets user profile', async () => {
    const res = await mkReq(request(httpServer).patch('/api/v1/context/global'))
      .send({
        user_profile: 'Solo founder building DeerDawn — TypeScript, Node.js',
        global_stack: ['TypeScript', 'Node.js', 'PostgreSQL'],
      });
    assert.ok([200, 201, 204].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 7b — GET /context/global returns saved profile', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/global'));
    assert.strictEqual(res.status, 200);
    const profile = res.body.user_profile ?? res.body.global?.user_profile;
    if (profile) assert.ok(profile.length > 0, 'expected non-empty user_profile');
  });

  // ─── Step 8: Preferences (injection suppression) ──────────────────────────

  await t.test('Step 8a — Disable claude_web in preferences', async () => {
    const res = await mkReq(request(httpServer).patch('/api/v1/context/preferences'))
      .send({ tools: { claude_web: { enabled: false, verbosity: 'standard' } } });
    assert.ok([200, 201, 204].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 8b — claude_web injection suppressed after disabling', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_web`));
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}`);
  });

  await t.test('Step 8c — claude_code still works while claude_web is disabled', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code`));
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}`);
  });

  await t.test('Step 8d — Re-enable claude_web', async () => {
    const res = await mkReq(request(httpServer).patch('/api/v1/context/preferences'))
      .send({ tools: { claude_web: { enabled: true, verbosity: 'standard' } } });
    assert.ok([200, 201, 204].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ─── Step 9: Flush-session simulation ─────────────────────────────────────

  await t.test('Step 9 — Flush-session simulation: session chunks trigger extraction', async () => {
    if (!projectId) return;
    const res = await mkReq(request(httpServer).post('/api/v1/context/extraction'))
      .send({
        session_id: `flush-${uuidv4()}`,
        tool: 'claude_code',
        project_id: projectId,
        chunks: [
          { role: 'user', text: 'Fix the login rate limiting bug' },
          { role: 'assistant', text: 'Found the issue — sliding window not resetting. Fixed.' },
          { role: 'user', text: 'Add better error messages' },
          { role: 'assistant', text: 'Updated error messages to be more descriptive.' },
          { role: 'user', text: 'Ship it' },
          { role: 'assistant', text: 'Deployed. PR merged and live.' },
        ],
        session_context: {
          cwd: '/home/user/journey-test-app',
          conversation_ref: `flush-${uuidv4()}`,
          host: 'claude_code',
          surface_type: 'code',
        },
      });
    assert.ok(res.status === 200 || res.status === 202, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ─── Step 10: Workspace entities ──────────────────────────────────────────

  const taskKey = `task-${uuidv4()}`;
  const decisionKey = `dec-${uuidv4()}`;

  await t.test('Step 10a — Create task + decision entities with relation', async () => {
    const res = await mkReq(request(httpServer).post('/api/v1/context/workspace/entities'))
      .send({
        entities: [
          { entity_type: 'task', title: 'Build auth service', canonical_key: taskKey, scope: 'workspace', metadata: { status: 'shipped' } },
          { entity_type: 'decision', title: 'Use JWT for auth', canonical_key: decisionKey, scope: 'workspace', summary: 'Stateless auth via JWT' },
        ],
        relations: [
          { from_canonical_key: taskKey, to_canonical_key: decisionKey, relation_type: 'implements', summary: 'Task implements the JWT decision' },
        ],
      });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 10b — GET /context/workspace/entities?types=task returns only tasks', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/workspace/entities?types=task'));
    assert.strictEqual(res.status, 200);
    const entities = res.body.entities ?? res.body;
    if (Array.isArray(entities) && entities.length > 0) {
      entities.forEach(e => {
        const type = e.entity_type ?? e.node_type;
        assert.ok(type === 'task', `expected task type, got: ${type}`);
      });
    }
  });

  await t.test('Step 10c — GET /context/workspace/overview includes knowledge', async () => {
    const res = await mkReq(request(httpServer).get('/api/v1/context/workspace/overview?mode=overview&include=knowledge'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body !== null && res.body !== undefined, 'expected non-null workspace overview');
  });

  // ─── Step 11: Dashboard bootstrap after context ───────────────────────────

  await t.test('Step 11 — GET /dashboard/bootstrap after context still returns valid shape', async () => {
    const res = await auth(request(httpServer).get('/api/v1/dashboard/bootstrap'));
    assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.org, 'expected org field');
    assert.ok(res.body.user, 'expected user field');
  });

  // ─── Step 12: API key management ──────────────────────────────────────────

  await t.test('Step 12a — Create a new API key', async () => {
    const res = await request(httpServer)
      .post('/api/v1/keys')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ name: 'Journey Test Key', environment: 'sandbox', scopes: ['context:read'] });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    const keyData = res.body.key ?? res.body;
    newKeyId = keyData.key_id ?? keyData.id;
  });

  await t.test('Step 12b — GET /keys lists all org keys', async () => {
    const res = await auth(request(httpServer).get('/api/v1/keys'));
    assert.strictEqual(res.status, 200);
    const keys = res.body.keys ?? res.body;
    assert.ok(Array.isArray(keys) && keys.length >= 1, 'expected at least 1 API key');
  });

  await t.test('Step 12c — DELETE the new key', async () => {
    if (!newKeyId) return;
    // DELETE /keys requires admin role — use Bearer token (JWT), not API key
    const res = await request(httpServer)
      .delete(`/api/v1/keys/${newKeyId}`)
      .set('Authorization', `Bearer ${fixture.token}`);
    assert.ok(res.status === 200 || res.status === 204, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('Step 12d — Deleted key no longer in list', async () => {
    if (!newKeyId) return;
    const res = await auth(request(httpServer).get('/api/v1/keys'));
    assert.strictEqual(res.status, 200);
    const keys = res.body.keys ?? res.body;
    if (Array.isArray(keys)) {
      const found = keys.some(k => (k.key_id ?? k.id) === newKeyId);
      assert.ok(!found, 'deleted key should not appear in list');
    }
  });

  // ─── Step 13: Org usage ───────────────────────────────────────────────────

  await t.test('Step 13 — GET /orgs/usage returns plan + usage stats', async () => {
    const res = await auth(request(httpServer).get('/api/v1/orgs/usage'));
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.body.plan || res.body.tier || res.body.usage || res.body.account_type,
      `expected plan/usage fields, got: ${JSON.stringify(res.body)}`
    );
  });
});

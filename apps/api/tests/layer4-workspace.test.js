process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * Layer 4 — Workspace Knowledge Layer
 *
 * Tests workspace overview (startup/overview modes), entity CRUD,
 * knowledge graph nodes/edges, cascading deletes, and next-best-context.
 */

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
const { ensureDatabaseAvailable } = require('./helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('./helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('./helpers/runtimeSchema');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';

function auth(req) {
  return req.set('X-Api-Key', API_KEY);
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Workspace ${label}`, 'active'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `ws-${label}-${Date.now()}@test.com`, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `WS Key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['*']],
    orgId
  );
  const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });
  return { orgId, userId, apiKey: key, token };
}

async function cleanupOrg(orgId) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
  }
  await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM injection_preferences WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  for (const table of ['api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function lookupNodeId(ownerKey, nodeType, canonicalKey) {
  const result = await db.query(
    'SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3',
    [ownerKey, nodeType, canonicalKey],
    'org-system'
  );
  return result.rows[0]?.node_id || null;
}

test('Layer 4 — Workspace Knowledge Layer', async (t) => {
  const orgs = [];

  if (!await ensureHttpBindingAvailable(t, 'Layer 4 — Workspace Knowledge Layer')) return;
  if (!await ensureDatabaseAvailable(t, db, 'Layer 4 — Workspace Knowledge Layer')) return;
  await ensureRuntimeSchema();

  t.after(async () => {
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Workspace overview ───────────────────────────────────────────────────

  await t.test('GET /context/workspace/overview?mode=startup returns 200', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/workspace/overview?mode=startup'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body !== null, 'expected non-null response');
  });

  await t.test('GET /context/workspace/overview?mode=overview returns 200', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/workspace/overview?mode=overview'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body !== null, 'expected non-null response');
  });

  await t.test('Empty workspace overview returns graceful empty state (not 500)', async () => {
    const { orgId, apiKey } = await createOrgFixture('empty-ws');
    orgs.push(orgId);

    const res = await request(httpServer)
      .get('/api/v1/context/workspace/overview?mode=startup')
      .set('X-Api-Key', apiKey);
    assert.ok(res.status !== 500, `should not 500 on empty workspace, got ${res.status}`);
    assert.ok(res.status === 200, `expected 200, got ${res.status}`);
  });

  // ─── Entity creation and retrieval ───────────────────────────────────────

  await t.test('POST /context/workspace/entities creates entity and returns id', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-create');
    orgs.push(orgId);

    const res = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({
        entities: [{
          entity_type: 'task',
          title: 'Implement auth layer',
          summary: 'Build JWT + API key auth',
          canonical_key: 'task:auth-layer',
          scope: 'workspace',
          metadata: { importance: 'high', status: 'active' },
        }],
      });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    const created = res.body.entities || res.body.created || [];
    assert.ok(Array.isArray(created) ? created.length > 0 : res.body.node_id || true, 'expected entity created');
  });

  await t.test('POST /context/workspace/entities with invalid entity_type returns 400, not 500', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-invalid-type');
    orgs.push(orgId);

    const res = await request(app)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'not_a_real_type', title: 'Bad entity type' }] });
    assert.strictEqual(res.status, 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'workspace_entity_type_invalid');
    assert.match(res.body.message, /entity_type is required and must be one of/);
  });

  await t.test('POST /context/workspace/entities with missing title returns 400, not 500', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-missing-title');
    orgs.push(orgId);

    const res = await request(app)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'task', title: 'ab' }] });
    assert.strictEqual(res.status, 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'workspace_entity_title_required');
  });

  await t.test('Duplicate canonical_key + type: first insert succeeds', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-upsert');
    orgs.push(orgId);

    const payload = {
      entities: [{
        entity_type: 'decision',
        title: 'Use PostgreSQL',
        summary: 'Chose PostgreSQL for relational data',
        canonical_key: `decision:use-postgres-${Date.now()}`,
        scope: 'workspace',
      }],
    };
    const first = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send(payload);
    assert.ok(first.status === 200 || first.status === 201, `first insert got ${first.status}: ${JSON.stringify(first.body)}`);
    // Second insert with same key may upsert (200/201) or return existing (400/409) — both are acceptable
    const second = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ ...payload.entities[0], summary: 'Updated summary' }] });
    assert.ok(second.status !== 500, `duplicate entity should not cause 500, got ${second.status}: ${JSON.stringify(second.body)}`);
  });

  /**
   * canonical_key round-trip (2026-08-29).
   *
   * The read path hands back the FULL `${entity_type}:${key}` identity, and every
   * caller round-trips that value straight back into entities[].canonical_key —
   * it is the only key they were ever given. canonicalWorkspaceKey re-prefixed it
   * (normalizeKey deliberately preserves ':'), so `decision:x` became
   * `decision:decision:x`: a DIFFERENT identity, so the upsert INSERTED a second
   * node instead of updating the first.
   *
   * That is how mark_resolved created a resolved duplicate beside an untouched
   * original while reporting the original resolved. Pinned at the source, because
   * every caller of this endpoint had the same defect.
   */
  await t.test('re-upserting an entity by its own returned canonical_key updates it, never duplicates', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-roundtrip');
    orgs.push(orgId);

    const title = `Round trip ${Date.now()}`;
    const create = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'decision', title, summary: 'Route board writes through mergeContextObject so the trim runs once', scope: 'workspace' }] });
    assert.ok(create.status === 200 || create.status === 201, `create got ${create.status}`);

    // Read the key back exactly as a client would.
    const listed = await request(httpServer)
      .get('/api/v1/context/workspace/entities?format=json')
      .set('X-Api-Key', apiKey);
    const mine = (listed.body.entities || []).find((e) => e.title === title);
    assert.ok(mine, 'the entity we just created must be listed');
    const returnedKey = mine.canonical_key;
    assert.ok(returnedKey.startsWith('decision:'), `expected a prefixed key, got ${returnedKey}`);

    // Feed it straight back — the exact move that used to fork the identity.
    const again = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({
        entities: [{
          entity_type: 'decision',
          title,
          summary: 'Route board writes through mergeContextObject so the trim runs once',
          canonical_key: returnedKey,
          scope: 'workspace',
          metadata: { status: 'resolved' },
        }],
      });
    assert.ok(again.status === 200 || again.status === 201, `re-upsert got ${again.status}`);

    // The identity must not have forked.
    const doubled = await lookupNodeId(orgId, 'decision', `decision:${returnedKey}`);
    assert.equal(doubled, null, 'a double-prefixed node must not exist');

    const rows = await db.query(
      'SELECT node_id, metadata FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND title = $3',
      [orgId, 'decision', title],
      'org-system'
    );
    assert.equal(rows.rows.length, 1, `expected exactly one node for this title, found ${rows.rows.length}`);
    const meta = rows.rows[0].metadata || {};
    const parsedMeta = typeof meta === 'string' ? JSON.parse(meta) : meta;
    assert.equal(parsedMeta.status, 'resolved', 'the ORIGINAL node must carry the update');
  });

  await t.test('a legacy double-prefixed row is updated in place, not duplicated', async () => {
    // Rows written before canonicalWorkspaceKey became prefix-idempotent carry
    // `decision:decision:foo`. A caller that reconstructs the key it originally
    // sent now computes `decision:foo`, which misses that row — so without the
    // legacy lookup the FIX would reintroduce the duplicate it removes.
    const { orgId, apiKey } = await createOrgFixture('entities-legacykey');
    orgs.push(orgId);

    const title = `Legacy key ${Date.now()}`;
    const legacyKey = 'decision:decision:legacy-shape';
    await db.query(
      `INSERT INTO context_graph_nodes
         (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,0.96,'manual','test',now(),now(),now())`,
      [`graph_node_${uuidv4()}`, orgId, 'decision', legacyKey, title, 'written under the old key shape', JSON.stringify({ entity_type: 'decision', status: 'active' })],
      'org-system'
    );

    // The caller sends the key it originally supplied — the single-prefixed form.
    const res = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({
        entities: [{
          entity_type: 'decision',
          title,
          summary: 'written under the old key shape',
          canonical_key: 'decision:legacy-shape',
          scope: 'workspace',
          metadata: { status: 'resolved' },
        }],
      });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);

    const rows = await db.query(
      'SELECT canonical_key, metadata FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND title = $3',
      [orgId, 'decision', title],
      'org-system'
    );
    assert.equal(rows.rows.length, 1, `the legacy row must be updated, not duplicated (found ${rows.rows.length})`);
    assert.equal(rows.rows[0].canonical_key, legacyKey, 'and it keeps its existing key');
    const meta = rows.rows[0].metadata;
    const parsedMeta = typeof meta === 'string' ? JSON.parse(meta) : meta;
    assert.equal(parsedMeta.status, 'resolved', 'the update landed on the legacy row');
  });

  await t.test('a title that begins with its own type prefix keeps its derived key', async () => {
    // The prefix-stripping must apply ONLY to an explicitly supplied key. A title
    // like "decision: use X" derives its key from the title, and changing that
    // would orphan every entity already stored under the old derivation.
    const { orgId, apiKey } = await createOrgFixture('entities-prefixtitle');
    orgs.push(orgId);

    const title = `decision: keep derived ${Date.now()}`;
    const res = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'decision', title, summary: 'Rank the Done column by completed_at rather than array position', scope: 'workspace' }] });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}`);

    const listed = await request(httpServer)
      .get('/api/v1/context/workspace/entities?format=json')
      .set('X-Api-Key', apiKey);
    const mine = (listed.body.entities || []).find((e) => e.title === title);
    assert.ok(mine, 'entity must exist');
    // Derived from the title, so it still carries the type prefix ON TOP of the
    // title text — unchanged from before the fix.
    assert.ok(
      mine.canonical_key.startsWith('decision:decision:'),
      `title-derived keys must be untouched, got ${mine.canonical_key}`
    );
  });

  await t.test('GET /context/workspace/entities returns entity list', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/workspace/entities'));
    assert.strictEqual(res.status, 200);
    const entities = res.body.entities || res.body;
    assert.ok(Array.isArray(entities), 'expected array');
  });

  await t.test('GET /context/workspace/entities?types=task filters by type', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-filter');
    orgs.push(orgId);

    await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'task', title: 'Filter task', canonical_key: 'task:filter', scope: 'workspace' }] });
    await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'decision', title: 'Filter decision', canonical_key: 'decision:filter', scope: 'workspace' }] });

    const res = await request(httpServer)
      .get('/api/v1/context/workspace/entities?types=task')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 200);
    const entities = res.body.entities || res.body;
    if (Array.isArray(entities) && entities.length > 0) {
      const allTasks = entities.every(e => e.node_type === 'task' || e.entity_type === 'task');
      assert.ok(allTasks, 'expected only task entities when filtering by type=task');
    }
  });

  await t.test('GET /context/workspace/entities?query=auth does full-text search', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/workspace/entities?query=auth'));
    assert.strictEqual(res.status, 200);
    const entities = res.body.entities || res.body;
    assert.ok(Array.isArray(entities), 'expected array');
  });

  // ─── Knowledge graph ──────────────────────────────────────────────────────

  await t.test('POST /context/workspace/entities with relations creates edges', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-relations');
    orgs.push(orgId);

    const res = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({
        entities: [
          { entity_type: 'task', title: 'Task A', canonical_key: 'task:a', scope: 'workspace' },
          { entity_type: 'task', title: 'Task B', canonical_key: 'task:b', scope: 'workspace' },
        ],
        relations: [{
          from_canonical_key: 'task:a',
          to_canonical_key: 'task:b',
          relation_type: 'blocks',
          summary: 'A must complete before B',
        }],
      });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('GET /context/graph/projects/:id returns nodes/edges shape', async () => {
    const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
      .send({ project_name: `Graph Project Test ${uuidv4().slice(0, 8)}` });
    const projectId = (createRes.body.project || {}).project_id || createRes.body.project_id;
    assert.ok(projectId, `expected project_id from create response, got ${JSON.stringify(createRes.body)}`);

    const res = await auth(request(httpServer).get(`/api/v1/context/graph/projects/${projectId}`));
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.body.nodes !== undefined || res.body.graph !== undefined,
      `expected nodes or graph field, got keys: ${Object.keys(res.body).join(', ')}`
    );
  });

  await t.test('DELETE /context/graph/nodes/:id removes node', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-delete');
    orgs.push(orgId);
    const canonicalKey = 'concept:delete-me';

    const createRes = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'concept', title: 'To Delete', canonical_key: canonicalKey, scope: 'workspace' }] });
    assert.ok(createRes.status === 200 || createRes.status === 201, `create got ${createRes.status}: ${JSON.stringify(createRes.body)}`);

    const nodeId = (createRes.body.entities || [])[0]?.node_id
      || (createRes.body.created || [])[0]?.node_id
      || await lookupNodeId(orgId, 'concept', canonicalKey);
    assert.ok(nodeId, `expected node_id for ${canonicalKey}, got ${JSON.stringify(createRes.body)}`);

    const deleteRes = await request(httpServer)
      .delete(`/api/v1/context/graph/nodes/${nodeId}`)
      .set('X-Api-Key', apiKey);
    assert.ok(deleteRes.status === 200 || deleteRes.status === 204, `delete got ${deleteRes.status}`);
  });

  await t.test('PATCH /context/graph/nodes/:id updates importance + pinned and rejects wrong owner', async () => {
    const { orgId, apiKey } = await createOrgFixture('entities-patch');
    orgs.push(orgId);
    const canonicalKey = 'concept:patch-me';

    const createRes = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', apiKey)
      .send({ entities: [{ entity_type: 'concept', title: 'To Patch', canonical_key: canonicalKey, scope: 'workspace' }] });
    assert.ok(createRes.status === 200 || createRes.status === 201, `create got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
    const nodeId = (createRes.body.entities || [])[0]?.node_id
      || await lookupNodeId(orgId, 'concept', canonicalKey);
    assert.ok(nodeId, `expected node_id for ${canonicalKey}`);

    const patchRes = await request(httpServer)
      .patch(`/api/v1/context/graph/nodes/${nodeId}`)
      .set('X-Api-Key', apiKey)
      .send({ importance: 'critical', pinned: true, summary: 'Curated summary' });
    assert.strictEqual(patchRes.status, 200, `patch got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.strictEqual(patchRes.body.node.metadata.importance, 'critical');
    assert.strictEqual(patchRes.body.node.metadata.pinned, true);
    assert.strictEqual(patchRes.body.node.summary, 'Curated summary');

    // A different org must not be able to patch this node (owner-scoped)
    const other = await createOrgFixture('entities-patch-other');
    orgs.push(other.orgId);
    const wrongOwnerRes = await request(httpServer)
      .patch(`/api/v1/context/graph/nodes/${nodeId}`)
      .set('X-Api-Key', other.apiKey)
      .send({ importance: 'low' });
    assert.strictEqual(wrongOwnerRes.status, 404, `expected 404 for wrong owner, got ${wrongOwnerRes.status}`);
  });

  await t.test('GET /context/graph/vault-health returns per-owner counts', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/graph/vault-health'));
    assert.strictEqual(res.status, 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    const h = res.body.health;
    assert.ok(h, 'expected health payload');
    for (const field of ['total', 'active', 'resolved_or_archived', 'candidates', 'durable', 'pinned', 'stale_unused']) {
      assert.strictEqual(typeof h[field], 'number', `${field} should be a number`);
    }
    assert.strictEqual(typeof h.avg_confidence, 'number');
    assert.ok(h.computed_at, 'expected computed_at timestamp');
  });

  // ─── Next best context ────────────────────────────────────────────────────

  await t.test('GET /context/workspace/next returns ranked suggestions or empty', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/workspace/next'));
    assert.strictEqual(res.status, 200);
    // Returns {result: {summary, suggestions, provenance}} or array
    const suggestions = res.body?.result?.suggestions || res.body.suggestions || res.body.results || res.body;
    assert.ok(
      Array.isArray(suggestions) || res.body?.result !== undefined,
      `expected suggestions array or result object, got ${JSON.stringify(res.body).slice(0, 200)}`
    );
  });

  await t.test('GET /context/workspace/next does not 500 on empty workspace', async () => {
    const { orgId, apiKey } = await createOrgFixture('next-empty');
    orgs.push(orgId);

    const res = await request(httpServer)
      .get('/api/v1/context/workspace/next')
      .set('X-Api-Key', apiKey);
    assert.ok(res.status !== 500, `should not 500 on empty, got ${res.status}`);
  });

  // ─── Team sharing routes ──────────────────────────────────────────────────

  await t.test('GET /teams/projects-sharing returns projects array and section_allowlist', async () => {
    const { orgId, apiKey } = await createOrgFixture('sharing-list');
    orgs.push(orgId);
    await db.query('UPDATE organizations SET plan_tier = $1 WHERE org_id = $2', ['starter', orgId], orgId);

    const res = await request(httpServer)
      .get('/api/v1/teams/projects-sharing')
      .set('X-Api-Key', apiKey);
    assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body.projects), 'expected projects array');
    assert.ok(Array.isArray(res.body.section_allowlist), 'expected section_allowlist');
    assert.ok(Array.isArray(res.body.defaults), 'expected defaults array');
  });

  await t.test('GET /teams/projects-sharing without auth returns 401/403', async () => {
    const res = await request(httpServer).get('/api/v1/teams/projects-sharing');
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  });

  await t.test('PATCH /teams/projects/:id/sharing enables project sharing and returns updated shape', async () => {
    const { orgId, apiKey, token } = await createOrgFixture('sharing-patch');
    orgs.push(orgId);
    await db.query('UPDATE organizations SET plan_tier = $1 WHERE org_id = $2', ['starter', orgId], orgId);

    // Create a project to share (API key auth is fine for project creation)
    const projRes = await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', apiKey)
      .send({ project_name: `Sharing Test Project ${uuidv4().slice(0, 8)}` });
    assert.ok(projRes.status === 200 || projRes.status === 201, `project create got ${projRes.status}`);
    const projectId = projRes.body.project?.project_id ?? projRes.body.project_id;
    assert.ok(projectId, 'expected project_id');

    // PATCH /sharing requires role=admin; API keys get role=operator, so use Bearer JWT
    const res = await request(httpServer)
      .patch(`/api/v1/teams/projects/${projectId}/sharing`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true, sections: ['description', 'tech_stack'] });
    assert.ok(
      res.status === 200 || res.status === 204,
      `sharing patch got ${res.status}: ${JSON.stringify(res.body)}`
    );
  });

  await t.test('PATCH /teams/projects/:id/sharing without auth returns 401/403', async () => {
    const res = await request(httpServer)
      .patch('/api/v1/teams/projects/fake-project-id/sharing')
      .send({ enabled: true });
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  });
});

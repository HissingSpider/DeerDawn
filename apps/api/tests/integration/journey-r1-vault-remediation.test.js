/**
 * JOURNEY ROUND 1 — THE NIGHTLY VAULT JOB AND TEXT A PERSON WROTE.
 *
 * An agent recorded "SSO" / "Active task for Q4: replace SAML with OIDC for
 * every enterprise tenant." with manage_memory upsert_entities, got "Upserted 3
 * workspace entities", and that night runVaultRemediation DELETED it (its title
 * was under 10 characters) and replaced the summary of "Data residency" ("Open
 * question for the security review: ...") with its title. Phase 1 matched every
 * row, across every owner, whose summary merely STARTED WITH one of four
 * phrases a generator stopped writing on 2026-06-04 — so the only rows it could
 * still find were ones a person or their agent wrote.
 *
 * Rule for every phase: text a person or their agent wrote is never deleted or
 * rewritten by this job, whatever it starts with. Each test below seeds two
 * accounts with ordinary text that resembles what one phase looks for, runs
 * the whole job as the scheduler does, and asserts nothing changed.
 *
 * DB-backed, and run with ENCRYPTION_MASTER_KEY set, as production is:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r1-vault-remediation.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const vault = require('../../src/jobs/vaultRemediationJob');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active', 5],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { label, orgId, userId, email, jwt, key };
}

function as(method, path, person) {
  return request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`).set('x-deerdawn-workspace', person.orgId);
}

async function mcpCall(person, name, args) {
  const r = await request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${person.key}`).set('x-deerdawn-workspace', person.orgId)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text };
}

// One person with one project of their own.
async function account(label, projectName = null) {
  const S = await makePerson(label);
  const name = projectName || `${label} ${uuidv4().slice(0, 6)}`;
  const created = await as('post', '/api/v1/context/projects', S).send({ project_name: name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { S, P: created.body.project.project_id, name };
}

// manage_memory upsert_entities on the hosted dispatcher, the agent's door.
async function upsertByMcp({ S, P }, entities) {
  const out = await mcpCall(S, 'manage_memory', {
    action: 'upsert_entities', project_id: P,
    entities: entities.map((e) => ({ scope: 'project', project_id: P, ...e })),
  });
  assert.equal(out.err, false, out.text);
  assert.match(out.text, /Upserted \d+ workspace entit/);
}

// POST /workspace/entities, the door the local stdio server and dashboard use.
async function upsertByRest({ S, P }, entities) {
  const r = await as('post', '/api/v1/context/workspace/entities', S)
    .send({ entities: entities.map((e) => ({ scope: 'project', project_id: P, ...e })) });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
}

// Every graph row the given owners hold, as a comparable snapshot.
async function nodesOf(...owners) {
  return (await q(
    `SELECT node_id, owner_key, project_id, node_type, title, summary, metadata, updated_at
     FROM context_graph_nodes WHERE owner_key = ANY($1::text[]) ORDER BY node_id`,
    [owners.map((o) => o.S.orgId)],
  )).rows.map((row) => ({ ...row, updated_at: new Date(row.updated_at).toISOString() }));
}

async function contextsOf(...owners) {
  const out = {};
  for (const { S, P } of owners) {
    const project = await store.getProject(S.orgId, P);
    out[P] = { context: project.context, updated_at: project.updated_at };
  }
  return out;
}

async function runJob() {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await vault.runVaultRemediation();
  } finally {
    console.error = originalError;
  }
  const failed = errors.find((line) => line.includes('[VAULT-REMEDIATION]') && line.includes('failed'));
  assert.equal(failed, undefined, `a phase failed: ${failed}`);
}

const titles = (rows) => rows.map((row) => `${row.title} :: ${row.summary}`).sort();

// ── Phase 1: template summaries ─────────────────────────────────────────────

test('phase 1: entities a person wrote whose summaries begin "Active task for" / "Open question for" / ... are neither deleted nor rewritten', async () => {
  const A = await account('vaulta');
  await upsertByMcp(A, [
    { title: 'Data residency', entity_type: 'question', summary: 'Open question for the security review: may backups leave the EU region?' },
    { title: 'SSO', entity_type: 'decision', summary: 'Active task for Q4: replace SAML with OIDC for every enterprise tenant.' },
    { title: 'Onboarding checklist owner', entity_type: 'knowledge', summary: 'Open question for Dana: who signs off the onboarding checklist each release?' },
  ]);
  const B = await account('vaultb', `Atlas ${uuidv4().slice(0, 6)}`);
  await upsertByRest(B, [
    { title: 'Friday freeze', entity_type: 'preference', summary: `Recurring context remembered for ${B.name}: deploys freeze on Fridays.` },
    { title: 'Rounding', entity_type: 'decision', summary: 'Decision captured automatically by the importer is wrong; we round half-even.' },
    { title: 'Kickoff', entity_type: 'task', summary: 'Active task for the new hire: read the runbook.' },
    // The generator's EXACT sentence, typed today: still a person's words.
    { title: 'Backup region', entity_type: 'question', summary: `Open question for ${B.name}.` },
  ]);

  const before = await nodesOf(A, B);
  assert.ok(titles(before).includes('SSO :: Active task for Q4: replace SAML with OIDC for every enterprise tenant.'), JSON.stringify(titles(before)));
  await runJob();
  const after = await nodesOf(A, B);
  assert.deepEqual(titles(after), titles(before), 'no entity deleted and no summary replaced');
  assert.deepEqual(after, before, 'every row is exactly as it was written');
});

test('phase 1: a provable legacy template row (the generator\'s exact sentence, written before it was removed) is repaired from its title, never deleted', async () => {
  const A = await account('legacy', `Ledger ${uuidv4().slice(0, 6)}`);
  const tag = uuidv4().slice(0, 8);
  const legacyAt = '2026-05-20T10:00:00.000Z';
  const insert = async (suffix, { type, title, summary, project = A.P, updatedAt = legacyAt }) => {
    const id = `graph_node_legacy_${tag}_${suffix}`;
    await q(
      `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 0.9, '', 'context_sync', $9, $10, $10)`,
      [id, A.S.orgId, project, type, `${type}:legacy-${tag}-${suffix}`, title, summary,
        JSON.stringify({ source_kind: 'inferred', curation_state: 'promoted', memory_tier: 'durable', auto_promoted: true, retrieval_hits: 1 }),
        legacyAt, updatedAt],
    );
    return id;
  };
  // What buildAutoPromotedMemoryEntities / inferStructuredEventEntities wrote
  // until 734380e4: the content in the title, a template in the summary.
  const repaired = {
    [await insert('task', { type: 'task', title: 'SSO', summary: `Active task for ${A.name}.` })]: 'SSO',
    [await insert('question', { type: 'question', title: 'May backups leave the EU region?', summary: `Open question for ${A.name}.` })]: 'May backups leave the EU region?',
    [await insert('decision', { type: 'decision', title: 'Replace SAML with OIDC for every enterprise tenant', summary: `Decision captured automatically for ${A.name}.` })]: 'Replace SAML with OIDC for every enterprise tenant',
    [await insert('preference', { type: 'preference', title: 'Deploys freeze on Fridays', summary: `Recurring context remembered for ${A.name}.` })]: 'Deploys freeze on Fridays',
    [await insert('workspace', { type: 'question', title: 'Who owns the status page?', summary: 'Open question for Workspace.', project: null })]: 'Who owns the status page?',
  };
  // Not the generator's sentence, not its type, or written since: left alone.
  const untouched = [
    await insert('prefix', { type: 'question', title: 'Backups', summary: `Open question for ${A.name}: may backups leave the EU?` }),
    await insert('type', { type: 'knowledge', title: 'Backups', summary: `Open question for ${A.name}.` }),
    await insert('rewritten', { type: 'task', title: 'Kickoff', summary: `Active task for ${A.name}.`, updatedAt: new Date().toISOString() }),
  ];
  const before = Object.fromEntries((await nodesOf(A)).map((row) => [row.node_id, row]));

  await runJob();
  const after = Object.fromEntries((await nodesOf(A)).map((row) => [row.node_id, row]));
  for (const [id, title] of Object.entries(repaired)) {
    assert.ok(after[id], `${title}: a legacy template row is repaired, never deleted`);
    assert.equal(after[id].summary, title, `${title}: its summary is its title`);
    assert.equal(after[id].metadata.remediation, 'template_repair');
  }
  for (const id of untouched) assert.deepEqual(after[id], before[id], `${before[id].title} (${id.split('_').pop()}) is left alone`);
});

// ── Phase 2: 2023 decided_at dates ──────────────────────────────────────────

test('phase 2 (retired in round 6): a decision a person dated in 2023 keeps its date', async () => {
  // A date somebody gave (PATCH, update_context, an extraction told "unless the
  // conversation references a past date") and a date a model invented are the
  // same string, so the phase that rewrote them is gone.
  const A = await account('dated');
  const B = await account('datedb');
  for (const [{ S, P }, summary] of [
    [A, 'Chose Postgres over MongoDB for the ledger'],
    [B, 'Adopted trunk-based development with short-lived branches'],
  ]) {
    const r = await as('patch', `/api/v1/context/projects/${P}/context`, S)
      .send({ recent_decisions: [{ summary, decided_at: '2023-03-14T09:00:00.000Z' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  }
  const before = await contextsOf(A, B);
  await runJob();
  assert.deepEqual(await contextsOf(A, B), before, 'the dates a person gave are kept');
});

// ── Phase 3: summaries over 400 characters ──────────────────────────────────

test('phase 3: a summary a person wrote by hand over 400 characters is not truncated', async () => {
  const A = await account('blob');
  const B = await account('blobb');
  const long = (topic) => `${topic}: ${'The migration runs in three passes, each idempotent, each resumable from its own checkpoint table, and each verified against the row counts of the source before the next begins. '.repeat(4)}`.trim();
  for (const [owner, title, text] of [[A, 'Ledger migration plan', long('Ledger')], [B, 'Search reindex plan', long('Search')]]) {
    await upsertByRest(owner, [{ title, entity_type: 'knowledge', summary: 'placeholder, edited below' }]);
    const node = (await q('SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND title = $2', [owner.S.orgId, title])).rows[0];
    // The vault editor (PATCH /graph/nodes/:id) takes a hand edit whole.
    const r = await as('patch', `/api/v1/context/graph/nodes/${node.node_id}`, owner.S).send({ summary: text });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(text.length > 400);
  }
  const before = await nodesOf(A, B);
  assert.equal(before.filter((row) => row.summary.length > 400).length, 2);
  // A blob from before the store capped summaries is still what the phase is for.
  const blob = `graph_node_blob_${uuidv4()}`;
  await q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, $3, 'knowledge', $4, 'Session write-up', $5, '{}'::jsonb, 0.7, '', 'context_sync', '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z')`,
    [blob, A.S.orgId, A.P, `knowledge:${blob}`, long('Write-up')],
  );
  await runJob();
  const after = await nodesOf(A, B);
  assert.deepEqual(after.filter((row) => row.node_id !== blob), before, 'a hand edit is kept whole');
  const cut = after.find((row) => row.node_id === blob);
  assert.equal(cut.summary.length, 280, 'a pre-cap blob is still cut to the store\'s cap');
  assert.equal(cut.metadata.blob_truncated, true);
});

// ── Phase 4: stale candidate nodes ──────────────────────────────────────────

test('phase 4: entities a person wrote and nobody has touched for a month are not pruned', async () => {
  const A = await account('stale');
  const B = await account('staleb');
  await upsertByMcp(A, [
    { title: 'Payout retries', entity_type: 'question', summary: 'Do payout retries need an idempotency key per attempt or per payout?' },
    { title: 'Pager rota', entity_type: 'knowledge', summary: 'The pager rota rotates on Mondays at 09:00 UTC.' },
  ]);
  await upsertByRest(B, [
    { title: 'Candidate pipeline', entity_type: 'task', summary: 'Wire the candidate pipeline into the hiring dashboard.' },
  ]);
  await q(
    `UPDATE context_graph_nodes SET last_seen_at = NOW() - INTERVAL '30 days', updated_at = NOW() - INTERVAL '30 days'
     WHERE owner_key = ANY($1::text[])`,
    [[A.S.orgId, B.S.orgId]],
  );
  const before = await nodesOf(A, B);
  assert.ok(before.length >= 3);
  await runJob();
  assert.deepEqual(await nodesOf(A, B), before);
});

// ── Phase 5: duplicate decision nodes ───────────────────────────────────────

test('phase 5: two decisions a person wrote with the same wording about different subjects both survive', async () => {
  const A = await account('twin');
  const B = await account('twinb');
  await upsertByMcp(A, [
    { title: 'Checkout service language', entity_type: 'decision', summary: 'Write the service in Go 1.23 with the standard library HTTP router.' },
    { title: 'Search service language', entity_type: 'decision', summary: 'Write the service in Go 1.23 with the standard library HTTP router.' },
  ]);
  await upsertByRest(B, [
    { title: 'Staging database', entity_type: 'decision', summary: 'Use Postgres 16 with logical replication to the analytics replica.' },
    { title: 'Production database', entity_type: 'decision', summary: 'use Postgres 16 with logical replication to the analytics replica' },
  ]);
  // Two questions answered the same way: each answer's node is titled by its
  // question (inferStructuredEventEntities), and is not hand-curated. The brief
  // takes the answer once, and promotes it to a third node of its own.
  for (const question of ['Which region hosts the EU tenants?', 'Which region hosts the disaster-recovery replica?']) {
    const r = await as('post', '/api/v1/context/events', B.S)
      .send({ event_type: 'question_answered', project_id: B.P, summary: 'Frankfurt (eu-central-1), on dedicated hosts.', metadata: { question } });
    assert.equal(r.status, 202, JSON.stringify(r.body).slice(0, 300));
  }
  let before = [];
  for (let i = 0; i < 50; i += 1) {
    before = await nodesOf(A, B);
    if (before.filter((row) => row.node_type === 'decision').length >= 7) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(before.filter((row) => row.node_type === 'decision').length, 7, JSON.stringify(titles(before)));
  await runJob();
  assert.deepEqual(titles(await nodesOf(A, B)), titles(before), 'no decision is deleted as a duplicate of a different one');
});

// ── Phase 6: resolved graph decisions onto the brief ────────────────────────

test('phase 6: a resolved decision resolves only its own brief entry, not one that resembles it or another account\'s', async () => {
  const A = await account('resolve');
  const B = await account('resolveb');
  const day = 86400000;
  const decidedAt = new Date(Date.now() - 3 * day).toISOString();
  for (const { S, P } of [A, B]) {
    const r = await as('patch', `/api/v1/context/projects/${P}/context`, S).send({ recent_decisions: [
      { summary: 'Adopt Redis as the cache layer', decided_at: decidedAt },
      { summary: 'Adopt Redis as the cache layer for sessions and the payout queue', decided_at: decidedAt },
      { summary: 'adopt redis', decided_at: decidedAt },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  }
  // A resolves ONE decision that shares words with all three of its own.
  const res = await mcpCall(A.S, 'manage_memory', { action: 'upsert_entities', project_id: A.P, entities: [
    { title: 'Adopt Redis as the cache layer for rate limits', entity_type: 'decision', summary: 'Adopt Redis as the cache layer for rate limits', scope: 'project', project_id: A.P, metadata: { status: 'resolved' } },
  ] });
  assert.equal(res.err, false, res.text);
  const node = (await q(
    `SELECT metadata->>'status' AS status FROM context_graph_nodes
     WHERE owner_key = $1 AND node_type = 'decision' AND title = $2`,
    [A.S.orgId, 'Adopt Redis as the cache layer for rate limits'],
  )).rows[0];
  assert.equal(node?.status, 'resolved', 'the phase has a resolved node to propagate');
  const before = await contextsOf(A, B);
  await runJob();
  assert.deepEqual(await contextsOf(A, B), before, 'no entry either account wrote is resolved by a look-alike');
});

// ── Phase 7: blockers against newer decisions ───────────────────────────────

test('phase 7 (retired in round 6): a newer decision that mentions a fix but not the blocker being gone leaves the blocker', async () => {
  // "Resolved" / "shipped" plus word overlap reads "Not resolved: ... still
  // failing" as a resolution, and any tuning is still a word match, so the
  // phase that cleared blockers on it is gone.
  const A = await account('blocker');
  const B = await account('blockerb');
  for (const [{ S, P }, blocker, decision] of [
    [A, 'Stripe webhook signature verification failing on staging',
      'Not resolved: Stripe webhook signature verification still failing on staging after the retry fix'],
    [B, 'Search index rebuild times out on the largest tenant',
      'Shipped the search index rebuild progress bar; the rebuild still times out on the largest tenant'],
  ]) {
    let r = await as('patch', `/api/v1/context/projects/${P}/context`, S).send({ blocking_issue: blocker });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    r = await as('patch', `/api/v1/context/projects/${P}/context`, S)
      .send({ recent_decisions: [{ summary: decision, decided_at: new Date(Date.now() + 5000).toISOString() }] });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  }
  const before = await contextsOf(A, B);
  await runJob();
  assert.deepEqual(await contextsOf(A, B), before, 'both blockers are still there');
});

// ── Phase 8: never-retrieved stale nodes ────────────────────────────────────

test('phase 8: entities a person wrote and nobody has retrieved for 50 days are not archived', async () => {
  const A = await account('unused');
  const B = await account('unusedb');
  await upsertByMcp(A, [
    { title: 'Escalation contact', entity_type: 'knowledge', summary: 'Escalate payment incidents to the finance on-call, not the platform one.' },
  ]);
  await upsertByRest(B, [
    { title: 'Archive retention', entity_type: 'decision', summary: 'Keep archived invoices for seven years.' },
  ]);
  await q(
    `UPDATE context_graph_nodes SET last_seen_at = NOW() - INTERVAL '50 days', updated_at = NOW() - INTERVAL '50 days'
     WHERE owner_key = ANY($1::text[])`,
    [[A.S.orgId, B.S.orgId]],
  );
  const before = await nodesOf(A, B);
  assert.ok(before.length >= 2);
  await runJob();
  assert.deepEqual(await nodesOf(A, B), before);
});

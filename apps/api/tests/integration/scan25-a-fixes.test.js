/**
 * SCAN 25 (a).
 *
 *   1. MEDIUM (data loss): nightly phase 5 compared decision TITLES, which the
 *      extractor clips to 80 characters + "...". Two distinct decisions sharing
 *      their first 79 characters collapsed (the newer was deleted), and a
 *      decision typed with a trailing "..." swallowed every longer decision it
 *      prefixed. The full text (the summary; the canonical key where the summary
 *      itself was clipped) now decides.
 *   2. MEDIUM: record_finding validated the raw paths, so `paths: [""]` — which
 *      models send — was a 400 on REST, hosted record_finding and /events. The
 *      paths are normalized (trimmed, blanks dropped) before the schema check.
 *   3. MEDIUM: a new task kept the previous task's server-written
 *      "Completed: <old task>" status, for the owner and a member alike.
 *   4. (not fixed: hosted recall is readOnlyHint:true and must write nothing,
 *      so a project read only through it can still age out.)
 *   5. MEDIUM: resolve propagation — live (workspace entities / mark_resolved)
 *      and nightly phase 6 — matched a decision against the resolved node's
 *      clipped title by prefix, so resolving one of two decisions sharing their
 *      first 79 characters resolved both. decisionNodeMatches reads the node's
 *      full text; behind a clip only the slug key decides, else nothing.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan25-a-fixes.test.js
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

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function mintKey(person, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args, path = '/mcp') {
  const r = await request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`).set('x-deerdawn-workspace', ws)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

async function soloProject(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const name = `${label} ${uuidv4().slice(0, 6)}`;
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { S, P: created.body.project.project_id, name };
}

// ── 1: phase 5 decides on the full text, never the clipped title ────────────

const vault = require('../../src/jobs/vaultRemediationJob');

test('1: decisions sharing a clipped title, or a typed "..." prefix, all survive phase 5; a genuine duplicate still collapses', async () => {
  const { S, P } = await soloProject('dup');
  const tag = uuidv4().slice(0, 6);
  // Exactly what the extractor writes (contextGraphService clip / normalizeKey).
  const { clip, normalizeKey } = require('../../src/services/contextGraphService');
  const insert = async (suffix, full, ageMinutes, { key = `decision:${tag}-${suffix}` } = {}) => {
    const id = `graph_node_zq${tag}_${suffix}`;
    await q(
      `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, last_seen_at)
       VALUES ($1, $2, $3, 'decision', $4, $5, $6, $7::jsonb, 0.86, 's', 'codex', NOW() - ($8 || ' minutes')::interval, NOW() - ($8 || ' minutes')::interval)`,
      [id, S.orgId, P, key, clip(full, 80), clip(full), JSON.stringify({ decided_at: new Date().toISOString() }), String(ageMinutes)],
    );
    return id;
  };
  const slug = (full) => `decision:${normalizeKey(full)}`;

  // The scanner's five: two sharing a 79-character title, and a typed "..."
  // decision that prefixes two longer ones.
  const prefix = `Pricing ${tag}: the Team plan is billed per seat monthly through Stripe checkout and `;
  const a = await insert('a', `${prefix}annual prepay gets a 20 percent discount for every seat purchased`, 60);
  const b = await insert('b', `${prefix}seats removed mid-cycle are credited pro rata on the next invoice`, 30);
  const c = await insert('c', `Deploy ${tag} the API and the worker to Fly.io in iad and then...`, 50);
  const d = await insert('d', `Deploy ${tag} the API and the worker to Fly.io in iad and then add a second region in ams`, 20);
  const e = await insert('e', `Deploy ${tag} the API and the worker to Fly.io in iad and then move Postgres to Neon`, 10);

  // Two long decisions whose SUMMARIES the extractor clipped at the same 239
  // characters: only the keys still carry the difference.
  const long = `Billing ${tag} ${'the invoice run reconciles every seat change against the Stripe subscription items and '.repeat(3)}`;
  const f = await insert('f', `${long}then emails the owner`, 40, { key: slug(`${long}then emails the owner`) });
  const g = await insert('g', `${long}then posts to the billing channel`, 35, { key: slug(`${long}then posts to the billing channel`) });

  // Genuine duplicates: the same short decision in other case/spacing, and the
  // same long decision with a trailing stop (the only way two extractor keys of
  // one text can differ).
  const h = await insert('h', `Adopt Redis ${tag} as the session cache layer.`, 55);
  const hCopy = await insert('i', `adopt   redis ${tag} as the SESSION cache layer`, 25);
  const j = await insert('j', `${long}and archives the receipt`, 45, { key: slug(`${long}and archives the receipt`) });
  const jCopy = await insert('k', `${long}and archives the receipt.`, 15, { key: slug(`${long}and archives the receipt.`) });

  await vault.runVaultRemediation();
  const ids = new Set((await q('SELECT node_id FROM context_graph_nodes WHERE project_id = $1', [P])).rows.map((r) => r.node_id));
  for (const [id, why] of [
    [a, 'the earlier of two decisions sharing a clipped title'],
    [b, 'the later of two decisions sharing a clipped title is not a duplicate'],
    [c, 'a typed "..." decision'],
    [d, 'a longer decision is not a copy of a typed "..." prefix'],
    [e, 'nor is a second one'],
    [f, 'a clipped-summary decision'],
    [g, 'a different decision whose summary clips to the same 239 characters'],
    [h, 'the survivor of a genuine duplicate'],
    [j, 'the survivor of a genuine clipped duplicate'],
  ]) assert.ok(ids.has(id), `kept: ${why}`);
  assert.ok(!ids.has(hCopy), 'the same decision in other case and spacing still collapses');
  assert.ok(!ids.has(jCopy), 'the same clipped decision differing only by a trailing stop still collapses');
});

// ── 2: a blank path is no path, on every door ───────────────────────────────

test('2: a finding with paths [""] (or a blank beside a real path) is stored on REST, hosted record_finding and /events', async () => {
  const { S, P } = await soloProject('paths');
  const key = await mintKey(S, S.orgId);
  const notes = async () => (await store.getProject(S.orgId, P)).context.debugging_notes || [];
  const noteFor = async (summary) => (await notes()).find((n) => n.summary === summary);

  const rest = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId)
    .send({ summary: 'The cron stalls when the queue drains', paths: [''] });
  assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 300));
  assert.deepEqual((await noteFor('The cron stalls when the queue drains'))?.paths, []);

  const mixed = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId)
    .send({ summary: 'The worker leaks sockets on retry', paths: ['src/a.js', ' ', ' src/a.js '] });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body).slice(0, 300));
  assert.deepEqual((await noteFor('The worker leaks sockets on retry'))?.paths, ['src/a.js']);

  for (const path of ['/mcp', '/mcp/claude']) {
    const summary = `The exporter truncates unicode names via ${path}`;
    const out = await mcpCall(key, S.orgId, 'manage_memory', { action: 'record_finding', project_id: P, summary, paths: [''] }, path);
    assert.equal(out.err, false, out.text);
    assert.deepEqual((await noteFor(summary))?.paths, [], path);
  }

  const ev = await as('post', '/api/v1/context/events', S, S.orgId)
    .send({ event_type: 'debug_finding', project_id: P, summary: 'The webhook retries forever on 410', metadata: { paths: [''] } });
  assert.ok(ev.status < 300, `${ev.status} ${JSON.stringify(ev.body).slice(0, 300)}`);
  assert.deepEqual((await noteFor('The webhook retries forever on 410'))?.paths, []);

  // A path of the wrong type is still refused, naming the field.
  const bad = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId)
    .send({ summary: 'A finding with a numeric path', paths: [42] });
  assert.equal(bad.status, 400);
});

// ── 3: a new task does not open under the old task's "Completed: …" ─────────

const sessionCatchup = require('../../src/services/sessionCatchupService');

test('3: a new task set after finish_task clears the old task\'s completion status, for the owner and a default-share member', async () => {
  const O = await makePerson('own', { plan: 'developer_pro' });
  const M = await makePerson('mem');
  await join(O, M);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  for (const [who, key] of [['owner', okey], ['member', mkey]]) {
    const created = await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Status ${who} ${uuidv4().slice(0, 6)}` });
    assert.equal(created.status, 201);
    const P = created.body.project.project_id;
    if (who === 'member') {
      // The default share: the member may set the task, not curate the rest.
      const share = await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T).send({ visibility: 'shared' });
      assert.equal(share.status, 200, JSON.stringify(share.body));
    }
    assert.equal((await mcpCall(okey, T, 'manage_memory', { action: 'update', project_id: P, task: 'Ship the invoice exporter' })).err, false);
    // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
    await mcpCall(okey, T, 'manage_memory', { action: 'finish_task', project_id: P });
    const fin = await mcpCall(okey, T, 'manage_memory', { action: 'finish_task', project_id: P, complete_task: true, confirm_complete: true });
    assert.equal(fin.err, false, fin.text);
    assert.equal((await store.getProject(T, P)).context.current_status, 'Completed: Ship the invoice exporter');

    const set = await mcpCall(key, T, 'manage_memory', { action: 'update', project_id: P, task: 'Build the refunds webhook' });
    assert.equal(set.err, false, `${who}: ${set.text}`);
    const c = (await store.getProject(T, P)).context;
    assert.equal(c.current_task, 'Build the refunds webhook', who);
    assert.equal(c.current_status || '', '', `${who}: the old task's completion status is not the new task's`);
    assert.doesNotMatch(sessionCatchup.buildResumeHint(c) || '', /Completed/, who);
    const brief = await mcpCall(okey, T, 'start_session', { project_id: P });
    assert.doesNotMatch(brief.text, /Current status: Completed: Ship the invoice exporter/, who);
  }
});

test('3b: a status the caller sends, or one somebody typed, survives a new task', async () => {
  const { S, P, name } = await soloProject('solo-status');
  const patch = (body) => as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId).send(body);
  const stored = async () => (await store.getProject(S.orgId, P)).context;

  assert.equal((await patch({ current_task: 'Ship the invoice exporter', current_status: 'Completed: the csv writer; now on the pdf one' })).status, 200);
  assert.equal((await patch({ current_task: 'Build the refunds webhook' })).status, 200);
  assert.equal((await stored()).current_status, 'Completed: the csv writer; now on the pdf one', 'a typed status is not the server\'s');

  assert.equal((await patch({ current_status: 'Completed: Build the refunds webhook', task_progress: 'completed' })).status, 200);
  assert.equal((await patch({ current_task: 'Harden the payout worker', current_status: 'Picking up where the webhook left off' })).status, 200);
  assert.equal((await stored()).current_status, 'Picking up where the webhook left off', 'a status sent with the task is kept');

  assert.equal((await patch({ current_status: 'Completed: Harden the payout worker', task_progress: 'completed' })).status, 200);
  assert.equal((await patch({ current_task: 'Harden the payout worker' })).status, 200);
  assert.equal((await stored()).current_status, 'Completed: Harden the payout worker', 'the same task re-sent is not a new one');

  // The extraction merge applies the same rule to a task it lands.
  const extract = (delta) => as('post', '/api/v1/context/extraction', S, S.orgId).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: P,
    chunks: [{ role: 'user', text: 'x' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.9,
      project_candidate: { project_id: P, project_name: name, score: 0.9 },
      delta,
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  const ext = await extract({ current_task: 'Wire the refunds ledger export' });
  assert.equal(ext.status, 202, JSON.stringify(ext.body).slice(0, 300));
  const c = await stored();
  assert.equal(c.current_task, 'Wire the refunds ledger export');
  assert.equal(c.current_status || '', '', 'an extracted new task clears the old completion status too');
});

// ── 5: a resolve reaches only its own decision, never one sharing a clip ────
//
// Resolve propagation (the live upsert and nightly phase 6) matched a decision
// against a resolved node's title — the summary clipped to 80 characters — and
// accepted any decision starting with that clip. Resolving one of two decisions
// sharing their first 79 characters resolved both.

async function decisionProject(label, summaries) {
  const { S, P } = await soloProject(label);
  const raw = await store.getProject(S.orgId, P);
  const actor = { id: S.userId, org_id: S.orgId, workspace_key: S.orgId, type: 'user', role: 'admin' };
  const decidedAt = new Date(Date.now() - 3600000).toISOString();
  await store.saveProject({
    ...raw,
    context: { ...(raw.context || {}), project_name: raw.project_name, recent_decisions: summaries.map((summary) => ({ summary, decided_at: decidedAt })) },
    updated_at: new Date().toISOString(),
  }, actor);
  const resolvedOf = async () => Object.fromEntries(((await store.getProject(S.orgId, P)).context.recent_decisions || [])
    .map((d) => [d.summary, Boolean(d.resolved)]));
  return { S, P, resolvedOf };
}

test('5a: nightly phase 6 resolves only the decision its node stands for, not every decision sharing the clipped title', async () => {
  const tag = uuidv4().slice(0, 6);
  const { clip, normalizeKey } = require('../../src/services/contextGraphService');
  const prefix = `Pricing ${tag}: the Team plan is billed per seat monthly through Stripe checkout and `;
  const A = `${prefix}annual prepay gets a 20 percent discount for every seat purchased`;
  const B = `${prefix}seats removed mid-cycle are credited pro rata on the next invoice`;
  const lead = `Hosting ${tag}: the API, the worker and the cron runner all deploy to Fly.io in the iad region and `;
  const C = `${lead}Postgres moves to Neon`;
  const D = `${lead}Redis stays on Upstash`;
  const E = `Adopt Redis ${tag} as the session cache layer.`;
  const F = `Adopt Redis ${tag} as the rate limiter store.`;
  const { S, P, resolvedOf } = await decisionProject('phase6', [A, B, C, D, E, F]);
  const node = async (suffix, full, { summary = clip(full), key = `decision:${normalizeKey(full)}` } = {}) => q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool)
     VALUES ($1, $2, $3, 'decision', $4, $5, $6, $7::jsonb, 0.86, 's', 'codex')`,
    [`graph_node_zq${tag}_${suffix}`, S.orgId, P, key, clip(full, 80), summary,
      JSON.stringify({ status: 'resolved', resolved_at: new Date().toISOString() })],
  );
  await node('a', A); // a resolved node with its full summary
  await node('c', C, { summary: '' }); // only the clipped title left: the key decides
  await node('e', E); // an ordinary short decision
  await vault.runVaultRemediation();
  const r = await resolvedOf();
  assert.equal(r[A], true, 'the resolved node\'s own decision is resolved');
  assert.equal(r[B], false, 'a decision sharing its clipped title is not');
  assert.equal(r[C], true, 'a title-only node still resolves its own decision through the key');
  assert.equal(r[D], false, 'and not the one sharing its clip');
  assert.equal(r[E], true, 'a short decision still propagates');
  assert.equal(r[F], false);
});

test('5b: a node with only a clipped title and no slug key resolves nothing', async () => {
  const tag = uuidv4().slice(0, 6);
  const { clip } = require('../../src/services/contextGraphService');
  const lead = `Queues ${tag}: every background job runs on the shared BullMQ queue with three retries and `;
  const G = `${lead}exponential backoff`;
  const H = `${lead}a dead letter queue`;
  const { S, P, resolvedOf } = await decisionProject('phase6-nokey', [G, H]);
  await q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool)
     VALUES ($1, $2, $3, 'decision', $4, $5, '', $6::jsonb, 0.86, 's', 'codex')`,
    [`graph_node_zq${tag}_g`, S.orgId, P, `decision:hand-${tag}`, clip(G, 80), JSON.stringify({ status: 'resolved', resolved_at: new Date().toISOString() })],
  );
  await vault.runVaultRemediation();
  const r = await resolvedOf();
  assert.equal(r[G], false, 'which of the two it was cannot be told, so neither is resolved');
  assert.equal(r[H], false);
});

test('5c: the live resolve propagation (workspace entities) resolves only its own decision', async () => {
  const tag = uuidv4().slice(0, 6);
  const { clip, normalizeKey } = require('../../src/services/contextGraphService');
  const prefix = `Billing ${tag}: invoices are generated on the first of the month by the Stripe webhook and `;
  const A = `${prefix}emailed to the workspace owner as a PDF attachment`;
  const B = `${prefix}posted to the billing channel in Slack for review`;
  const E = `Keep the ledger ${tag} in Postgres 16.`;
  const { S, P, resolvedOf } = await decisionProject('live', [A, B, E]);
  const resolve = (full, extra = {}) => as('post', '/api/v1/context/workspace/entities', S, S.orgId).send({
    entities: [{
      entity_type: 'decision',
      title: clip(full, 80),
      summary: clip(full),
      canonical_key: `decision:${normalizeKey(full)}`,
      project_id: P,
      scope: 'project',
      metadata: { status: 'resolved', resolved_at: new Date().toISOString() },
      ...extra,
    }],
  });
  const one = await resolve(A);
  assert.ok(one.status < 300, `${one.status} ${JSON.stringify(one.body).slice(0, 300)}`);
  let r = await resolvedOf();
  assert.equal(r[A], true, 'the decision resolved is resolved');
  assert.equal(r[B], false, 'the one sharing its first 79 characters is not');

  const two = await resolve(E, { title: E, summary: 'Closed: we moved the ledger elsewhere' });
  assert.ok(two.status < 300, `${two.status} ${JSON.stringify(two.body).slice(0, 300)}`);
  r = await resolvedOf();
  assert.equal(r[E], true, 'an unclipped title still identifies its decision');
});

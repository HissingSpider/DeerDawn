/**
 * SCAN 26 (a). Resolving a decision marks exactly THAT decision resolved in THAT
 * project's brief — never another project's, never a sibling sharing a prefix —
 * and never answers success while doing nothing.
 *
 *   1. HIGH: a resolve ignored the project it named. Decision nodes are unique
 *      per owner and keep the FIRST project, and the propagation flipped that
 *      project's brief: the same decision in repos A and B, resolved in B,
 *      resolved A and left B open behind "already resolved — nothing to do"; a
 *      member's resolve flipped the owner's project; a Trail copy's flipped its
 *      source; and a lone loose search hit resolved another project's
 *      decision. A named project's resolve now reads and writes THAT brief by
 *      the decision's own text (service.resolveProjectDecision — hosted
 *      mark_resolved, and the local server through POST
 *      /projects/:id/decisions/resolve); an upsert filing a resolve under B
 *      touches B's brief and not A's node; resolve takes only an exact match.
 *   2. HIGH (round-25 regression): resolving through upsert_entities / POST
 *      workspace/entities with the title recall lists (79 characters + "...")
 *      created a NEW resolved node keyed on the clip and left the brief open
 *      while answering "saved". The write goes to the one decision node in the
 *      project carrying that clip; a clip is matched by prefix only when exactly
 *      one open decision starts with it (live and nightly), and two is refused
 *      and said.
 *   3. MEDIUM (data loss, round-25 regression): decisionNodeText knew only the
 *      extractor's 240 + "..." cut. The store caps every summary at 279 + "…",
 *      so two decisions over 280 characters sharing their first 279 read as one
 *      decision and nightly phase 5 deleted one. The store's cut is a cut; the
 *      node's full title decides when it is longer, else the canonical key.
 *   4. MEDIUM: resolve_question (hosted, and REST POST .../questions/resolve)
 *      recorded its answer as a decision in the brief but wrote no graph node
 *      until some later update rebuilt the graph, so the new decision was not in
 *      recall entities and could not be resolved by its text. It records the
 *      graph artifacts the way an update does.
 *   5. LOW: a decision over the 500 characters a hosted `title` admits (the
 *      advertised maxLength, frozen with the catalog) could not be resolved
 *      exactly. A unique opening of 80+ characters in the named project now
 *      resolves it; an opening two decisions share resolves neither.
 *   6. LOW: a decision carrying a secret, recorded by event or hosted update, got
 *      TWO graph nodes — the event door keyed the raw text (a secretSafeKey
 *      hash), the auto-promotion keyed the brief's redacted text — so every
 *      resolve of it was refused as "matches 2 entities". A decision is keyed on
 *      its redacted text on every door.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan26-a-fixes.test.js
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function solo(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  return { S, key };
}

const decisionsOf = async (ownerKey, projectId) => Object.fromEntries(((await store.getProject(ownerKey, projectId)).context.recent_decisions || [])
  .map((d) => [d.summary, Boolean(d.resolved)]));
const decisionNodes = async (ownerKey, projectId) => (await q(
  `SELECT node_id, canonical_key, title, summary, metadata->>'status' AS status FROM context_graph_nodes
   WHERE owner_key = $1 AND node_type = 'decision' AND ($2::text IS NULL OR project_id = $2) ORDER BY created_at`,
  [ownerKey, projectId],
)).rows;

// ── 6: one decision with a secret in it is one node ─────────────────────────

test('6: a decision carrying a secret, by event or hosted update, is ONE node and resolves', async () => {
  for (const door of ['event', 'hosted_update']) {
    const { S, key } = await solo(`secret-${door}`.slice(0, 16));
    const P = await newProject(S, 'secret');
    // Prefix joined at runtime: a Stripe-shaped literal trips GitHub push protection.
    const text = `Rotate the Stripe key ${uuidv4().slice(0, 6)} ${'sk_' + 'live_'}51HqLyjWDarjtT1zdp7dcXYZabc123456789 every quarter.`;
    if (door === 'event') {
      const r = await as('post', '/api/v1/context/events', S, S.orgId)
        .send({ event_type: 'decision_made', project_id: P, summary: text, tool: 'claude_code', session_id: `s-${uuidv4()}` });
      assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: text });
      assert.equal(r.err, false, r.text);
    }
    await wait(1200);
    const logged = Object.keys(await decisionsOf(S.orgId, P));
    assert.equal(logged.length, 1, `${door}: one decision logged`);
    assert.ok(!logged[0].includes('sk_live_'), 'the brief is redacted');
    const nodes = await decisionNodes(S.orgId, P);
    assert.equal(nodes.length, 1, `${door}: one decision, one node — ${JSON.stringify(nodes.map((n) => n.canonical_key))}`);
    assert.ok(nodes.every((n) => !n.canonical_key.includes('sk-live') && !n.canonical_key.includes('sk_live')), 'no secret in the key');

    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: logged[0] });
    assert.match(r.text, /Marked resolved/, `${door}: ${r.text}`);
    assert.equal((await decisionsOf(S.orgId, P))[logged[0]], true, `${door}: the brief entry is resolved`);
  }
});

// ── 3: the store's 280-character cut is a cut ───────────────────────────────

const vault = require('../../src/jobs/vaultRemediationJob');

test('3: two decisions over 280 characters sharing their first 279 both survive phase 5, and resolving one resolves only it', async () => {
  const { S, key } = await solo('p5-280');
  const P = await newProject(S, 'p5-280');
  const tag = uuidv4().slice(0, 6);
  const stem = `Decided ${tag} to run the nightly settlement reconciliation in a dedicated worker pool, isolated from the web tier, with its own database connection budget, its own retry budget of three attempts with exponential backoff, its own alerting route to the payments on-call rotation, and its own `;
  assert.ok(stem.length > 280);
  const A = `${stem}deploy pipeline gated on the ledger contract tests.`;
  const B = `${stem}feature flag so finance can pause it during month-end close.`;
  for (const text of [A, B]) {
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: text });
    assert.equal(r.err, false, r.text);
    await wait(900);
  }
  const before = await decisionNodes(S.orgId, P);
  assert.equal(before.length, 2, 'two decisions, two nodes');
  assert.ok(before.every((n) => n.summary.length === 280 && n.summary.endsWith('…')), 'the store cut both summaries to the same 280 characters');

  await vault.runVaultRemediation();
  const after = await decisionNodes(S.orgId, P);
  assert.deepEqual(after.map((n) => n.node_id).sort(), before.map((n) => n.node_id).sort(), 'phase 5 deleted neither: they are two decisions');

  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: B });
  assert.match(r.text, /Marked resolved/, r.text);
  await vault.runVaultRemediation();
  const log = await decisionsOf(S.orgId, P);
  assert.equal(log[B], true, 'the decision resolved is resolved');
  assert.equal(log[A], false, 'its sibling sharing 279 characters is not, live or nightly');
});

// ── 4: a question's answer is a graph node as soon as it is a decision ──────

test('4: resolve_question (hosted and REST) records its decision as a graph node straight away', async () => {
  const { S, key } = await solo('rq-node');
  const P = await newProject(S, 'rq-node');
  const tag = uuidv4().slice(0, 6);
  const patched = await as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId)
    .send({ open_questions: [`Which provider ${tag} handles payouts?`, `Which queue ${tag} backs retries?`] });
  assert.ok(patched.status < 300, JSON.stringify(patched.body).slice(0, 200));

  const hosted = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'resolve_question', project_id: P, question: `Which provider ${tag} handles payouts?`, answer: `Adyen ${tag}, because Stripe Connect is not available in Brazil`,
  });
  assert.match(hosted.text, /Resolved/, hosted.text);
  let titles = (await decisionNodes(S.orgId, P)).map((n) => n.title);
  assert.ok(titles.some((t) => t.includes(`Adyen ${tag}`)), `hosted: the answer is a decision node without waiting for another update — ${JSON.stringify(titles)}`);

  const rest = await as('post', `/api/v1/context/projects/${P}/questions/resolve`, S, S.orgId)
    .send({ question: `Which queue ${tag} backs retries?`, answer: `SQS ${tag} with a DLQ` });
  assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 200));
  titles = (await decisionNodes(S.orgId, P)).map((n) => n.title);
  assert.ok(titles.some((t) => t.includes(`SQS ${tag}`)), `REST: the answer is a decision node — ${JSON.stringify(titles)}`);

  const listed = await mcpCall(key, S.orgId, 'recall', { action: 'entities', project_id: P, types: ['decision'] });
  assert.match(listed.text, new RegExp(`Adyen ${tag}`), 'recall(action:"entities") lists it');
});

// ── 1: a resolve in a named project is that project's ───────────────────────

test('1a: the same decision in two projects — resolving it in B resolves B, never A, live or nightly', async () => {
  const { S, key } = await solo('two-proj');
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to use Postgres 16 ${uuidv4().slice(0, 6)} for the primary database.`;
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: A, summary: D });
  await wait(800);
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: B, summary: D });
  await wait(1200);
  const nodes = await decisionNodes(S.orgId, null);
  assert.equal(nodes.length, 1, 'one node per owner, filed under A (the premise)');

  const first = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: B, title: D });
  assert.match(first.text, /Marked resolved/, first.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], true, 'B, the project named, is resolved');
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'A is not');
  assert.notEqual((await decisionNodes(S.orgId, A))[0].status, 'resolved', 'A\'s node is A\'s, and untouched');

  const again = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: B, title: D });
  assert.match(again.text, /already resolved/, 'judged on B\'s brief');

  await vault.runVaultRemediation();
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'nightly does not carry B\'s resolve to A');
  assert.equal((await decisionsOf(S.orgId, B))[D], true);

  const inA = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: A, title: D });
  assert.match(inA.text, /Marked resolved/, inA.text);
  assert.equal((await decisionsOf(S.orgId, A))[D], true, 'A resolves when A is named');
  assert.equal((await decisionNodes(S.orgId, A))[0].status, 'resolved', 'and A\'s own node follows');
});

test('1b: a member resolving the decision in their own project leaves the owner\'s project open', async () => {
  const O = await makePerson('own26', { plan: 'developer_pro' });
  const M = await makePerson('mem26');
  await join(O, M, 'member');
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  const OP = await newProject(O, 'Owner proj', T);
  const MP = await newProject(M, 'Member proj', T);
  const E = `Decided to deploy on Fly.io ${uuidv4().slice(0, 6)} in the iad region.`;
  await mcpCall(okey, T, 'manage_memory', { action: 'update', project_id: OP, summary: E });
  await wait(800);
  await mcpCall(mkey, T, 'manage_memory', { action: 'update', project_id: MP, summary: E });
  await wait(1200);
  const r = await mcpCall(mkey, T, 'manage_memory', { action: 'resolve', project_id: MP, title: E });
  assert.match(r.text, /Marked resolved/, r.text);
  assert.equal((await decisionsOf(T, MP))[E], true, 'the member\'s own decision is resolved');
  assert.equal((await decisionsOf(T, OP))[E], false, 'the owner\'s is not');
});

test('1c: upsert_entities / POST workspace/entities filing a resolve under B resolves B\'s brief only, and says so', async () => {
  const { S, key } = await solo('two-proj-up');
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to keep the ledger ${uuidv4().slice(0, 6)} in Postgres 16.`;
  const D2 = `Decided to queue exports ${uuidv4().slice(0, 6)} on BullMQ.`;
  for (const P of [A, B]) {
    await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: D });
    await wait(700);
    await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: D2 });
    await wait(700);
  }
  const rest = await as('post', '/api/v1/context/workspace/entities', S, S.orgId).send({
    entities: [{ entity_type: 'decision', title: D, project_id: B, scope: 'project', metadata: { status: 'resolved' } }],
  });
  assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 300));
  assert.equal((await decisionsOf(S.orgId, B))[D], true, 'REST: B is resolved');
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'REST: A is not');
  assert.notEqual((await decisionNodes(S.orgId, A)).find((n) => n.title === D)?.status, 'resolved', 'A\'s node is not written');
  assert.ok((rest.body.decision_resolves || []).some((o) => o.project_id === B && o.resolved.includes(D)), JSON.stringify(rest.body.decision_resolves));

  const hosted = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'decision', title: D2, project_id: B, scope: 'project', metadata: { status: 'resolved' } }],
  });
  assert.equal(hosted.err, false, hosted.text);
  assert.match(hosted.text, /Resolved in the decision log of Repo B/, hosted.text);
  assert.equal((await decisionsOf(S.orgId, B))[D2], true, 'hosted: B is resolved');
  assert.equal((await decisionsOf(S.orgId, A))[D2], false, 'hosted: A is not');
  await vault.runVaultRemediation();
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'and nightly leaves A alone');
  assert.equal((await decisionsOf(S.orgId, A))[D2], false);
});

test('1d: a resolve never lands on a loose search hit — not another project\'s decision, not a lone partial match', async () => {
  const { S, key } = await solo('loose');
  const Other = await newProject(S, 'Other');
  const P = await newProject(S, 'Here');
  const tag = uuidv4().slice(0, 6);
  const theirs = `Decided to use Stripe Connect ${tag} for payouts in the other project.`;
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: Other, summary: theirs });
  await as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId).send({ open_questions: [`Which provider ${tag} handles payouts?`] });
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve_question', project_id: P, question: `Which provider ${tag} handles payouts?`, answer: `Adyen ${tag}, because Stripe Connect is not available in Brazil` });
  await wait(1200);
  const mine = Object.keys(await decisionsOf(S.orgId, P))[0];

  const own = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: mine });
  assert.match(own.text, /Marked resolved/, own.text);
  assert.equal((await decisionsOf(S.orgId, P))[mine], true, 'the named project\'s decision is the one resolved');
  assert.equal((await decisionsOf(S.orgId, Other))[theirs], false, 'the other project\'s is not');

  const cross = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: theirs });
  assert.match(cross.text, /nothing was resolved/, cross.text);
  assert.equal((await decisionsOf(S.orgId, Other))[theirs], false, 'naming P never resolves Other\'s decision');

  const partial = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: `Stripe Connect ${tag} for payouts` });
  assert.match(partial.text, /nothing was resolved/, partial.text);
  assert.equal((await decisionsOf(S.orgId, Other))[theirs], false, 'a lone partial match is not the decision');
});

test('1e: resolving a decision in an imported Trail copy resolves the copy, not its source', async () => {
  const { S, key } = await solo('trail');
  const P = await newProject(S, 'Trail Src');
  const D = `Decided to use Postgres 16 ${uuidv4().slice(0, 6)} for the ledger.`;
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: D });
  await wait(1000);
  const exp = await mcpCall(key, S.orgId, 'manage_memory', { action: 'export_trail', project_id: P });
  const trail = JSON.parse(exp.raw).result?.structuredContent?.trail;
  assert.ok(trail, exp.text.slice(0, 200));
  const copyName = `Trail Copy ${uuidv4().slice(0, 6)}`;
  const imp = await mcpCall(key, S.orgId, 'manage_memory', { action: 'import_trail', trail: typeof trail === 'string' ? trail : JSON.stringify(trail), new_project_name: copyName });
  assert.equal(imp.err, false, imp.text);
  const copy = (await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [S.orgId, copyName])).rows[0].project_id;
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: copy, title: D });
  assert.match(r.text, /Marked resolved/, r.text);
  assert.equal((await decisionsOf(S.orgId, copy))[D], true, 'the copy is resolved');
  assert.equal((await decisionsOf(S.orgId, P))[D], false, 'the source is not');
});

// ── 2: a decision named by its clipped title ────────────────────────────────

async function extractDecision(S, P, text) {
  const r = await as('post', '/api/v1/context/extraction', S, S.orgId).send({
    session_id: `s-${uuidv4()}`, tool: 'claude_code', project_id: P, chunk: { role: 'user', text },
    extraction: { match_decision: 'matched_existing', confidence: 0.95, project_candidate: { project_id: P, project_name: 'x' }, delta: { recent_decisions: [{ summary: text, decided_at: new Date().toISOString() }] }, should_create_project: false, needs_user_confirmation: false },
  });
  assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

test('2a: resolving by the title recall lists (79 characters + "...") resolves that decision, on REST, hosted upsert_entities and resolve, without a duplicate node', async () => {
  const cases = [
    (t) => `Adopt the shared BullMQ queue ${t} for every background job, with three retries, exponential backoff and a dead letter queue for poison messages.`,
    (t) => `Hosting ${t}: the API, the worker and the cron runner all deploy to Fly.io in the iad region; Postgres moves to Neon with branching per preview; Redis stays on Upstash with a 256MB cap; object storage is Cloudflare R2 fronted by a signed-URL worker; logs ship to Axiom.`,
  ];
  for (const make of cases) {
    for (const door of ['rest', 'hosted_upsert', 'hosted_resolve']) {
      const { S, key } = await solo(`clip-${door}`.slice(0, 16));
      const P = await newProject(S, 'clip');
      const text = make(uuidv4().slice(0, 6));
      await extractDecision(S, P, text);
      const [node] = await decisionNodes(S.orgId, P);
      assert.ok(node.title.endsWith('...') && node.title.length === 82, `the listed title is the extractor's clip: ${node.title}`);
      const listed = await mcpCall(key, S.orgId, 'recall', { action: 'entities', project_id: P, types: ['decision'] });
      assert.ok(listed.text.includes(node.title), 'recall lists the clipped title');

      const ent = { entity_type: 'decision', title: node.title, project_id: P, scope: 'project', metadata: { status: 'resolved' } };
      let reply;
      if (door === 'rest') {
        const r = await as('post', '/api/v1/context/workspace/entities', S, S.orgId).send({ entities: [ent] });
        assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
        reply = JSON.stringify(r.body.decision_resolves);
      } else if (door === 'hosted_upsert') {
        reply = (await mcpCall(key, S.orgId, 'manage_memory', { action: 'upsert_entities', entities: [ent] })).text;
      } else {
        reply = (await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: node.title })).text;
      }
      assert.equal((await decisionsOf(S.orgId, P))[text], true, `${text.length} chars via ${door}: the brief entry is resolved — ${reply}`);
      const after = await decisionNodes(S.orgId, P);
      assert.equal(after.length, 1, `${door}: no duplicate node keyed on the clip — ${JSON.stringify(after.map((n) => n.canonical_key))}`);
      assert.equal(after[0].status, 'resolved', `${door}: the decision's own node is resolved`);
    }
  }
});

test('2b: a clipped title two decisions begin with resolves neither, and the reply says so', async () => {
  const { S, key } = await solo('clip-two');
  const P = await newProject(S, 'clip-two');
  const tag = uuidv4().slice(0, 6);
  const lead = `Pricing ${tag}: the Team plan is billed per seat monthly through Stripe checkout and `;
  const A = `${lead}annual prepay gets a twenty percent discount for every seat purchased.`;
  const B = `${lead}seats removed mid-cycle are credited pro rata on the next invoice.`;
  await extractDecision(S, P, A);
  await extractDecision(S, P, B);
  const clipped = (await decisionNodes(S.orgId, P))[0].title;
  assert.ok(A.startsWith(clipped.slice(0, -3)) && B.startsWith(clipped.slice(0, -3)), 'both begin with the clip');

  const rest = await as('post', '/api/v1/context/workspace/entities', S, S.orgId).send({
    entities: [{ entity_type: 'decision', title: clipped, project_id: P, scope: 'project', metadata: { status: 'resolved' } }],
  });
  assert.equal(rest.status, 409, JSON.stringify(rest.body).slice(0, 300));
  assert.match(rest.body.message, /nothing was resolved/);
  const hosted = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'decision', title: clipped, project_id: P, scope: 'project', metadata: { status: 'resolved' } }],
  });
  assert.match(hosted.text, /nothing was resolved/, hosted.text);
  const resolve = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: clipped });
  assert.match(resolve.text, /matches 2 open decisions .* nothing was resolved/, resolve.text);
  const log = await decisionsOf(S.orgId, P);
  assert.equal(log[A], false);
  assert.equal(log[B], false);
  assert.equal((await decisionNodes(S.orgId, P)).length, 2, 'and no stray node keyed on the clip');
});

test('2c: nightly phase 6 resolves by a node\'s clipped title only when exactly one open decision begins with it', async () => {
  const { S } = await solo('clip-p6');
  const P = await newProject(S, 'clip-p6');
  const tag = uuidv4().slice(0, 6);
  const { clip } = require('../../src/services/contextGraphService');
  const lone = `Queues ${tag}: every background job runs on the shared BullMQ queue with three retries and a dead letter queue.`;
  const other = `Deploys ${tag} go out from main only.`;
  const raw = await store.getProject(S.orgId, P);
  const decidedAt = new Date(Date.now() - 3600000).toISOString();
  await store.saveProject({
    ...raw,
    context: { ...(raw.context || {}), recent_decisions: [lone, other].map((summary) => ({ summary, decided_at: decidedAt })) },
    updated_at: new Date().toISOString(),
  }, { id: S.userId, org_id: S.orgId, workspace_key: S.orgId, type: 'user', role: 'admin' });
  // What a resolve under the clipped title stored before this fix: the clip, and
  // a key that is the slug of the clip.
  const { normalizeKey } = require('../../src/services/contextGraphService');
  await q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool)
     VALUES ($1, $2, $3, 'decision', $4, $5, '', $6::jsonb, 0.9, 's', 'codex')`,
    [`graph_node_zq${tag}`, S.orgId, P, `decision:${normalizeKey(clip(lone, 80))}`, clip(lone, 80), JSON.stringify({ status: 'resolved', resolved_at: new Date().toISOString() })],
  );
  await vault.runVaultRemediation();
  const log = await decisionsOf(S.orgId, P);
  assert.equal(log[lone], true, 'the one decision the clip can mean is resolved');
  assert.equal(log[other], false);
});

// ── 5: a decision longer than a hosted title can carry ──────────────────────

test('5: a decision over 500 characters resolves by a unique opening of 80+ characters; a shared opening resolves nothing', async () => {
  const { S, key } = await solo('long-title');
  const P = await newProject(S, 'long-title');
  const tag = uuidv4().slice(0, 6);
  const body = 'the settlement worker reconciles every payout against the ledger, retries three times with backoff, pages the payments rotation on the third failure, and ';
  const long = `Decided ${tag}: ${body.repeat(4)}archives the run report to R2.`;
  const sibling = `Decided ${tag}: ${body}posts a summary to the finance channel.`;
  const other = `Decided ${tag} to keep the payout exporter on the web tier for now.`;
  assert.ok(long.length > 500);
  for (const text of [long, sibling, other]) {
    await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: text });
    await wait(700);
  }
  const whole = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: long });
  assert.equal(whole.err, true, 'the full text is over the advertised title limit (the catalog is frozen)');

  const shared = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: `Decided ${tag}: ${body}`.trim() });
  assert.match(shared.text, /nothing was resolved/, shared.text);
  let log = await decisionsOf(S.orgId, P);
  assert.equal(log[long], false, 'an opening two decisions share resolves neither');
  assert.equal(log[sibling], false);

  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: long.slice(0, 400) });
  assert.match(r.text, /Marked resolved/, r.text);
  log = await decisionsOf(S.orgId, P);
  assert.equal(log[long], true, 'the one decision that opening belongs to is resolved');
  assert.equal(log[sibling], false);
  assert.equal(log[other], false);
});

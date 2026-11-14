/**
 * SCAN 28 (a). A closed decision leaves the brief, and the text the brief shows
 * is enough to close one — without ever closing a sibling or a thing of another
 * type that reads the same.
 *
 *   1. HIGH: a resolved decision stayed in every brief's "Knowledge web" line
 *      (start_session, recall context on /mcp and /mcp/claude, REST /inject,
 *      and a teammate's brief) after mark_resolved said it "will no longer
 *      appear in normal context loads". And a 523-character decision printed
 *      whole there while "Recent decisions" cut it; it is cut the same way now.
 *   2. MEDIUM: a decision could not be resolved by the text the brief shows —
 *      its opening plus "..." (or recall's "…"). The trailing ellipsis is
 *      stripped and the rest resolves when exactly ONE open decision in the
 *      project begins with it; two is refused, naming both.
 *   3. MEDIUM: with no project_id and no entity_type, a task's text resolved a
 *      DECISION with the same text (or one it prefixes). An exact non-decision
 *      match now makes it ambiguous (both named), or wins over a prefix.
 *   5. LOW: a parent's resolve found a decision in a member's private child the
 *      caller cannot edit and failed with share_write_forbidden naming nothing.
 *      Such children are skipped; when one is the only place, it is named.
 *   6. LOW: POST /projects/:id/decisions/resolve audited the parent when the
 *      resolve landed in a subproject. It audits the project changed.
 *
 * (4, the local entityNamedExactly, is pinned in packages/mcp-server vitest.)
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan28-a-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
// NO LIVE MODEL. These pins are about how a resolve reads the decision log,
// and every update here goes through recordExplicitUpdate's extraction. With an
// OPENAI_API_KEY in the environment (a developer machine; CI has none) that is a
// live gpt-4o-mini call, and what it says varies run to run: it mirrors a
// decision into current_task (a same-worded open task, which round 28's guard
// rightly calls ambiguous), sets importance "high" (the brief then appends
// " ★ important" to the cut line), writes its own headline over the shown text,
// or judges a later update to resolve an earlier decision. The file ran green in
// CI and failed at random locally. Without a key the extraction is the
// deterministic fallback CI has always exercised.
const savedOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));
test.after(() => {
  if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
});

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


const extract = (S, P, delta, text) => as('post', '/api/v1/context/extraction', S, S.orgId).send({
  session_id: `s-${uuidv4()}`, tool: 'claude_code', project_id: P, chunk: { role: 'user', text },
  extraction: { match_decision: 'matched_existing', confidence: 0.95, project_candidate: { project_id: P, project_name: 'x' }, delta, should_create_project: false, needs_user_confirmation: false },
});
const decide = (S, P, summary) => extract(S, P, { recent_decisions: [{ summary, decided_at: new Date().toISOString() }] }, `We decided: ${summary}`);


async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.ok(accepted.ok, accepted.reason);
}
const update = async (key, ws, P, summary, path = '/mcp') => {
  const r = await mcpCall(key, ws, 'manage_memory', { action: 'update', project_id: P, summary }, path);
  assert.equal(r.err, false, r.text);
  await wait(350);
};
const knowledgeWeb = (text) => (String(text).match(/Knowledge web: ([^\n]*)/) || [])[1] || '';

// ── 1: a resolved decision leaves the Knowledge web ─────────────────────────

test('1a: after a resolve, no brief surface prints the decision in its Knowledge web line', async () => {
  const { S, key } = await solo('kw');
  const P = await newProject(S, 'KW');
  const tag = uuidv4().slice(0, 6);
  const gone = `Decided to drop Redis sessions ${tag} in favour of signed cookies.`;
  const kept = `Decided to keep the monorepo ${tag} on npm workspaces for now.`;
  for (const d of [gone, kept]) await update(key, S.orgId, P, d);
  const before = await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  assert.ok(knowledgeWeb(before.text).includes(gone), `precondition: the node is in the line: ${before.text}`);
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: gone, project_id: P });
  assert.match(r.text, /Marked resolved/, r.text);
  const surfaces = {
    start: (await mcpCall(key, S.orgId, 'start_session', { project_id: P })).text,
    recall: (await mcpCall(key, S.orgId, 'recall', { action: 'context', project_id: P })).text,
    claude: (await mcpCall(key, S.orgId, 'recall', { action: 'context', project_id: P }, '/mcp/claude')).text,
    inject: JSON.stringify((await as('get', `/api/v1/context/projects/${P}/inject?tool=claude_code`, S, S.orgId)).body),
  };
  for (const [where, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes('drop Redis sessions'), `${where} still briefs the resolved decision: ${text.slice(0, 600)}`);
    assert.ok(text.includes(`keep the monorepo ${tag}`), `${where} still briefs the open one`);
  }
  // History is not hidden: an explicit read of resolved entities still has it.
  const hist = await mcpCall(key, S.orgId, 'recall', { action: 'entities', status: 'resolved', types: ['decision'] });
  assert.ok(hist.text.includes('drop Redis sessions'), hist.text);
});

test('1b: a decision a teammate resolved leaves the owner\'s brief and the teammate\'s', async () => {
  const O = await makePerson('kw-own', { plan: 'developer_pro' });
  const M = await makePerson('kw-mem');
  await join(O, M, 'member');
  const okey = await mintKey(O, O.orgId);
  const mkey = await mintKey(M, O.orgId);
  const P = await newProject(O, 'KW team', O.orgId);
  const tag = uuidv4().slice(0, 6);
  const gone = `Decided to use Postgres 16 ${tag} for the primary ledger database.`;
  const kept = `Decided to keep the payout exporter ${tag} behind a flag until launch.`;
  for (const d of [gone, kept]) await update(okey, O.orgId, P, d);
  assert.ok(knowledgeWeb((await mcpCall(okey, O.orgId, 'start_session', { project_id: P })).text).includes(gone), 'precondition');
  const r = await mcpCall(mkey, O.orgId, 'manage_memory', { action: 'resolve', title: gone, project_id: P });
  assert.match(r.text, /Marked resolved/, r.text);
  for (const [who, key] of [['owner', okey], ['member', mkey]]) {
    const text = (await mcpCall(key, O.orgId, 'recall', { action: 'context', project_id: P })).text;
    assert.ok(!text.includes(`Postgres 16 ${tag}`), `${who}: ${text}`);
  }
});

// The brief's cut line, without the importance marker it appends AFTER the cut
// for a high/critical decision (shared-context formatInjection: "... ★
// important"). The marker is intended; it is not part of the decision's text.
const stripImportance = (line) => String(line).replace(/ (?:★ important|⚠ critical)$/, '');
const shownDecision = (text) => stripImportance((String(text).match(/Recent decisions: ([^\n]*)/) || [])[1] || '');

test('1c: a long decision is cut in the Knowledge web the way Recent decisions cuts it', async () => {
  const { S, key } = await solo('kw-long');
  const P = await newProject(S, 'KW long');
  const LONG_DECISION = `Set up the payout exporter ${uuidv4().slice(0, 6)}. Decided to use Postgres 16 for the ledger. Decided to call Stripe from the vault only. `
    + 'Decided to move settlement reconciliation into its own worker pool with a dedicated connection budget, a three-attempt retry budget with '
    + 'exponential backoff, a separate alert route to payments on-call, and a kill switch finance can flip without a deploy.';
  assert.ok(LONG_DECISION.length > 300);
  await update(key, S.orgId, P, LONG_DECISION);
  const st = await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  const shown = shownDecision(st.text);
  const web = knowledgeWeb(st.text);
  assert.ok(shown.endsWith('...') && shown.length < 120, `precondition: the brief cuts it: ${shown}`);
  assert.ok(web, `the decision is in the Knowledge web: ${st.text}`);
  assert.ok(!web.includes('kill switch finance'), `the Knowledge web prints it whole: ${web}`);
  assert.ok(web.includes(`decision: ${shown}`), `cut the same way: ${web} vs ${shown}`);
});

// ── 2: the text a brief shows for a cut decision resolves it ────────────────

test('2a: a 120-character decision resolves by the "..." cut start_session shows, with and without project_id', async () => {
  for (const withPid of [true, false]) {
    for (const path of ['/mcp', '/mcp/claude']) {
      const { S, key } = await solo('shown');
      const P = await newProject(S, 'Shown');
      const D120 = `Decided to pin Node 20 LTS ${uuidv4().slice(0, 6)} across the API, the worker and the CLI until the Fly base image ships Node 22 with OpenSSL 3.`;
      await update(key, S.orgId, P, D120, path);
      const st = await mcpCall(key, S.orgId, 'start_session', { project_id: P }, path);
      const shown = shownDecision(st.text);
      assert.ok(shown.endsWith('...') && shown.length < D120.length, `precondition: the brief cuts it: ${shown}`);
      const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: shown, ...(withPid ? { project_id: P } : {}) }, path);
      assert.match(r.text, /Marked resolved/, `${path} pid=${withPid}: ${r.text}`);
      assert.equal((await decisionsOf(S.orgId, P))[D120], true, `${path} pid=${withPid}`);
      const again = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: shown, project_id: P }, path);
      assert.match(again.text, /already resolved/, again.text);
    }
  }
});

test('2b: a long decision resolves by the "…" line recall(sections:["all"]) shows', async () => {
  const { S, key } = await solo('shown-all');
  const P = await newProject(S, 'Shown all');
  const D300 = `Decided to keep every webhook handler ${uuidv4().slice(0, 6)} idempotent by recording the provider event id in a unique table before doing any work, `
    + 'so that retries from Stripe, Adyen and the internal replay tool all collapse into one effect, and to alert when the same id arrives more than five times in an hour window.';
  await update(key, S.orgId, P, D300);
  const full = await mcpCall(key, S.orgId, 'recall', { action: 'context', project_id: P, sections: ['all'] });
  const line = full.text.split('\n').find((l) => l.startsWith('  - Decided to keep every webhook'));
  assert.ok(line, full.text);
  const shown = line.slice(4).trim();
  assert.ok(shown.length < D300.length, `precondition: recall cuts it: ${shown}`);
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: shown, project_id: P }, '/mcp/claude');
  assert.match(r.text, /Marked resolved/, r.text);
  assert.equal((await decisionsOf(S.orgId, P))[D300], true);
});

test('2c: a 523-character decision resolves by the cut the brief shows (no project_id)', async () => {
  const { S, key } = await solo('shown-long');
  const P = await newProject(S, 'Shown long');
  const LONG_DECISION = `Set up the payout exporter ${uuidv4().slice(0, 6)}. Decided to use Postgres 16 for the ledger. Decided to call Stripe from the vault only. `
    + 'Decided to move settlement reconciliation into its own worker pool with a dedicated connection budget, a three-attempt retry budget with exponential '
    + 'backoff, a separate alert route to payments on-call, a deploy pipeline gated on ledger contract tests, and a kill switch finance can flip without a '
    + 'deploy, and to review the whole arrangement again after the first full month of production payouts has settled.';
  assert.ok(LONG_DECISION.length > 500);
  await update(key, S.orgId, P, LONG_DECISION);
  const shown = shownDecision((await mcpCall(key, S.orgId, 'start_session', { project_id: P })).text);
  assert.ok(shown.endsWith('...'), shown);
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: shown });
  assert.match(r.text, /Marked resolved/, r.text);
  assert.equal((await decisionsOf(S.orgId, P))[LONG_DECISION], true);
});

test('2d: a shown cut two open decisions share is refused, naming both, and resolves neither', async () => {
  for (const withPid of [true, false]) {
    const { S, key } = await solo('shown-amb');
    const P = await newProject(S, 'Shown amb');
    const stem = `Decided to route every settlement export ${uuidv4().slice(0, 6)} through the reconciliation queue so that finance can replay`;
    const A = `${stem} a whole day of payouts without touching the ledger.`;
    const B = `${stem} a single payout batch from the dashboard.`;
    for (const d of [A, B]) await update(key, S.orgId, P, d);
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: `${stem.slice(0, 60)}...`, ...(withPid ? { project_id: P } : {}) });
    assert.doesNotMatch(r.text, /Marked resolved/, r.text);
    assert.ok(r.text.includes(A) && r.text.includes(B), `pid=${withPid}: both are named: ${r.text}`);
    assert.deepEqual(await decisionsOf(S.orgId, P), { [A]: false, [B]: false });
  }
});

test('2e: a decision aged out of the brief resolves its node by a shown cut; a shared cut is refused', async () => {
  const { S, key } = await solo('shown-node');
  const P = await newProject(S, 'Shown node');
  const tag = uuidv4().slice(0, 6);
  const text = `Adopt the shared BullMQ queue ${tag} for every background job, with three retries, exponential backoff and a DLQ`;
  const twinA = `Adopt the Temporal worker fleet ${tag} for the payout workflows, with a dedicated namespace per region and history export`;
  const twinB = `Adopt the Temporal worker fleet ${tag} for the payout workflows, with one shared namespace and a retention of thirty days`;
  for (const d of [text, twinA, twinB]) await decide(S, P, d);
  for (let i = 0; i < 21; i++) await decide(S, P, `Filler decision number ${i} ${uuidv4().slice(0, 6)} about the cache layout.`);
  assert.equal((await decisionsOf(S.orgId, P))[text], undefined, 'the brief no longer lists it');
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: `${text.slice(0, 64)}...` });
  assert.match(r.text, /Marked resolved/, r.text);
  const node = (await decisionNodes(S.orgId, P)).find((n) => (n.summary || '').startsWith(text.slice(0, 40)));
  assert.equal(node.status, 'resolved');
  const amb = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: `${twinA.slice(0, 70)}...` });
  assert.doesNotMatch(amb.text, /Marked resolved/, amb.text);
  const twins = (await decisionNodes(S.orgId, P)).filter((n) => (n.summary || '').includes(`Temporal worker fleet ${tag}`));
  assert.equal(twins.length, 2);
  assert.ok(twins.every((n) => n.status !== 'resolved'), amb.text);
  assert.ok(amb.text.includes(twinA) || amb.text.includes(twinA.slice(0, 79)), `both are named: ${amb.text}`);
});

// ── 3: no entity_type is not "decision" ─────────────────────────────────────

const taskNodes = async (ownerKey, projectId) => (await store.listGraphNodes(ownerKey, { nodeTypes: ['task'], limit: 50, includeResolved: true }))
  .filter((n) => n.project_id === projectId).map((n) => n.metadata?.status || 'open');

for (const shape of ['equal', 'prefix', 'short-equal']) {
  test(`3a (${shape}): a task's text with no project_id and no entity_type never resolves a decision in its place`, async () => {
    const { S, key } = await solo(`tvd-${shape}`);
    const P = await newProject(S, 'tvd');
    const t = uuidv4().slice(0, 6);
    const T = shape === 'short-equal' ? `Move payouts ${t} to Kafka` : `Move the payout ledger ${t} onto the shared Kafka cluster so reconciliation runs off a single stream`;
    const D = shape === 'prefix' ? `${T}, because the nightly batch kept missing late refunds.` : T;
    assert.equal((await extract(S, P, { current_task: T }, `Working on: ${T}`)).status, 202);
    assert.equal((await decide(S, P, D)).status, 202);
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: T });
    const decisions = await decisionsOf(S.orgId, P);
    const tasks = await taskNodes(S.orgId, P);
    if (shape === 'prefix') {
      // Only the task is named exactly; the decision is only one it opens.
      assert.match(r.text, /Marked resolved/, r.text);
      assert.equal(decisions[D], false, `the longer decision stays open: ${r.text}`);
      assert.deepEqual(tasks, ['resolved'], r.text);
    } else {
      assert.doesNotMatch(r.text, /Marked resolved/, r.text);
      assert.match(r.text, /\(decision\)/, r.text);
      assert.match(r.text, /\(task\)/, r.text);
      assert.match(r.text, /entity_type/, r.text);
      assert.equal(decisions[D], false, r.text);
      assert.ok(tasks.every((s) => s !== 'resolved'), r.text);
    }
  });
}

test('3b: entity_type "task" resolves the task, entity_type "decision" the decision, and a plain decision still resolves untyped', async () => {
  const { S, key } = await solo('tvd-typed');
  const P = await newProject(S, 'tvd typed');
  const T = `Move payouts ${uuidv4().slice(0, 6)} to Kafka`;
  await extract(S, P, { current_task: T }, `Working on: ${T}`);
  await decide(S, P, T);
  const rt = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: T, entity_type: 'task' });
  assert.match(rt.text, /Marked resolved/, rt.text);
  assert.deepEqual(await taskNodes(S.orgId, P), ['resolved']);
  assert.equal((await decisionsOf(S.orgId, P))[T], false, 'the decision is untouched');
  // With the task closed, the untyped text names only the decision.
  const rd = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: T });
  assert.match(rd.text, /Marked resolved/, rd.text);
  assert.equal((await decisionsOf(S.orgId, P))[T], true);
  const plain = `Decided to keep payouts ${uuidv4().slice(0, 6)} on the nightly batch for now.`;
  await decide(S, P, plain);
  const rp = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: plain, project_id: P });
  assert.match(rp.text, /Marked resolved/, rp.text);
  assert.equal((await decisionsOf(S.orgId, P))[plain], true);
});

test('3c: the REST resolve the local server calls weighs a task when told the resolve is untyped', async () => {
  const { S } = await solo('tvd-rest');
  const P = await newProject(S, 'tvd rest');
  const T = `Move payouts ${uuidv4().slice(0, 6)} to Kafka`;
  await extract(S, P, { current_task: T }, `Working on: ${T}`);
  await decide(S, P, T);
  const untyped = await as('post', `/api/v1/context/projects/${P}/decisions/resolve`, S, S.orgId).send({ title: T, untyped: true });
  assert.equal(untyped.status, 200);
  assert.equal(untyped.body.outcome, 'ambiguous', JSON.stringify(untyped.body));
  assert.equal((await decisionsOf(S.orgId, P))[T], false);
  const typed = await as('post', `/api/v1/context/projects/${P}/decisions/resolve`, S, S.orgId).send({ title: T });
  assert.equal(typed.body.outcome, 'resolved', JSON.stringify(typed.body));
});

// ── 5: a parent's resolve skips subprojects the caller cannot change ────────

test('5: a decision held only in a member\'s private child is named, not a bare share_write_forbidden', async () => {
  const O = await makePerson('sub-own', { plan: 'developer_pro' });
  const M = await makePerson('sub-mem');
  await join(O, M, 'member');
  const okey = await mintKey(O, O.orgId);
  const mkey = await mintKey(M, O.orgId);
  const P = await newProject(O, 'Umbrella', O.orgId);
  const mine = await newProject(O, 'API child', O.orgId);
  const theirs = await newProject(M, 'Private child', O.orgId);
  for (const [who, child] of [[O, mine], [M, theirs]]) {
    const r = await as('post', `/api/v1/context/projects/${child}/parent`, who, O.orgId).send({ parent_project_id: P });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await as('patch', `/api/v1/teams/projects/${theirs}/sharing`, M, O.orgId).send({ visibility: 'private' })).status, 200);
  const tag = uuidv4().slice(0, 6);
  const W = `Decided the private child caches tokens ${tag} for fifteen minutes only.`;
  const Z = `Decided both children log in structured JSON ${tag} with a request id.`;
  await update(mkey, O.orgId, theirs, W);
  await update(mkey, O.orgId, theirs, Z);
  await update(okey, O.orgId, mine, Z);

  const r = await mcpCall(okey, O.orgId, 'manage_memory', { action: 'resolve', title: W, project_id: P });
  assert.equal(r.err, false, r.text);
  assert.doesNotMatch(r.text, /Marked resolved/, r.text);
  assert.ok(r.text.includes('Private child') && r.text.includes(theirs), `names the project: ${r.text}`);
  assert.match(r.text, /not change/, r.text);
  assert.equal((await decisionsOf(O.orgId, theirs))[W], false);

  // Held in a child the owner can change AND one they cannot: the one they can.
  const r2 = await mcpCall(okey, O.orgId, 'manage_memory', { action: 'resolve', title: Z, project_id: P });
  assert.match(r2.text, /Marked resolved/, r2.text);
  assert.match(r2.text, /API child/, r2.text);
  assert.equal((await decisionsOf(O.orgId, mine))[Z], true);
  assert.equal((await decisionsOf(O.orgId, theirs))[Z], false);
});

// ── 6: the REST resolve audits the project it changed ───────────────────────

test('6: POST /projects/:parent/decisions/resolve landing in a subproject audits the subproject', async () => {
  const { S } = await solo('audit');
  const P = await newProject(S, 'Audit parent');
  const C = await newProject(S, 'Audit child');
  assert.equal((await as('post', `/api/v1/context/projects/${C}/parent`, S, S.orgId).send({ parent_project_id: P })).status, 200);
  const D = `Decided to audit the project a resolve changes ${uuidv4().slice(0, 6)}.`;
  await decide(S, C, D);
  const r = await as('post', `/api/v1/context/projects/${P}/decisions/resolve`, S, S.orgId).send({ title: D });
  assert.equal(r.body.outcome, 'resolved', JSON.stringify(r.body));
  assert.equal(r.body.project_id, C);
  await wait(400);
  const rows = (await q(
    'SELECT project_id FROM context_audit_logs WHERE owner_key = $1 AND action = \'context_write\' ORDER BY created_at DESC LIMIT 1',
    [S.orgId],
  )).rows;
  assert.equal(rows[0]?.project_id, C, JSON.stringify(rows));
});

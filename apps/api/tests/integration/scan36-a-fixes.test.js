/**
 * SCAN 36 (a). Whose words a one-person workspace's nodes carry, judged when
 * they leave it or when a second person arrives.
 *
 *   V1. A move out of a one-person workspace carries a node's words only when
 *       nothing staying has ANY evidence on it (sightings included): otherwise
 *       the moved copy is identity only and the node left behind keeps its
 *       summary and metadata (a/p1, a/p5, b/p116). Round 35 carried them and
 *       stripped the node at home, which published a sibling project's note to
 *       the team and erased it where it was written.
 *   V2. A graph write that computed a one-person landing while the first invite
 *       was being accepted no longer leaves its cross-project landings behind
 *       the split: it settles them itself once it sees the team (a/p3).
 *   V3. A write from another project never replaces a node's words, only
 *       records that it is used there (b/p114).
 *   V4. Split and carried copies keep a node's non-text state — status,
 *       pinned, tier, usage counters — never its words (b/p115, b/p117).
 *   V5. A scoped key is bounded, so one long decision cannot make every
 *       invite fail on the key index (b/p119).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan36-a-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);
const today = () => new Date().toISOString();

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
  assert.ok(accepted.ok, accepted.reason);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args) {
  let r = request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  r = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function share(person, ws, projectId, body) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function move(person, fromWs, projectId, toWs) {
  const res = await as('post', `/api/v1/teams/projects/${projectId}/move`, person, fromWs).send({ workspace: toWs });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
}

const upsert = (key, ws, args) => mcpCall(key, ws, 'manage_memory', { action: 'upsert_entities', ...args });
const recall = (key, ws, query) => mcpCall(key, ws, 'recall', { action: 'entities', query });

// The non-explicit POST /extraction every end-of-session flush makes: the delta
// is applied and the project's graph is rebuilt from its whole stored context.
function flushRaw(person, ws, projectId, delta, sessionId = `sess-${uuidv4()}`) {
  return as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: sessionId,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
}
async function flush(person, ws, projectId, delta) {
  const res = await flushRaw(person, ws, projectId, delta);
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  await wait(300);
  return res;
}

// Non-sighting evidence from `inProject` on a node homed in `homeProject`.
const evidenceCrossing = async (ownerKey, homeProject, inProject) => (await q(
  `SELECT n.canonical_key FROM context_graph_evidence e JOIN context_graph_nodes n ON n.node_id = e.node_id
    WHERE e.owner_key = $1 AND n.project_id = $2 AND e.project_id = $3
      AND COALESCE(e.metadata->>'kind', '') <> 'sighting' AND n.node_type <> 'project'`,
  [ownerKey, homeProject, inProject],
)).rows;

const nodesTitled = async (ownerKey, marker) => (await q(
  `SELECT node_id, node_type, canonical_key, project_id, summary, metadata
     FROM context_graph_nodes n
    WHERE owner_key = $1 AND title ILIKE $2 AND node_type <> 'project'
    ORDER BY canonical_key`,
  [ownerKey, `%${marker}%`],
)).rows;

// A note ANOTHER project's save left on a node, as rows written before V3 have
// it: the store used to replace any summary under 40 characters, whichever
// project the write came from. V3 stops new ones; the carry must still judge
// the ones already stored.
async function legacyNoteOn(ownerKey, nodeId, note) {
  await q('UPDATE context_graph_nodes SET summary = $3 WHERE owner_key = $1 AND node_id = $2', [ownerKey, nodeId, note]);
}

// ── V1. A move out of a one-person workspace leaves ambiguous words home ────

test('V1 (a/p1): moving A out of a solo workspace does not carry the note B left on A\'s node, and B keeps it', async () => {
  const O = await makePerson('s36p1o', { plan: 'developer_pro' });
  const M = await makePerson('s36p1m');
  const M2 = await makePerson('s36p1n');
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const W = M.orgId;
  const wkey = await mintKey(M, W);
  const m2key = await mintKey(M2, T);
  const mk = tag();
  const A = await newProject(M, `ApiA${mk}`, W);
  const B = await newProject(M, `SideB${mk}`, W);
  const D = `Adopt Kafka${mk} for events`;
  await flush(M, W, A, { recent_decisions: [{ summary: D, decided_at: today() }] });
  const saved = await upsert(wkey, W, { project_id: B, entities: [{ entity_type: 'decision', title: D, summary: `BNOTE${mk}: only because my side gig at Acme pays` }] });
  assert.equal(saved.err, false, saved.text);
  const [node] = (await nodesTitled(W, `Kafka${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(node.project_id, A, 'precondition: the node is homed in A');
  await legacyNoteOn(W, node.node_id, `BNOTE${mk}: only because my side gig at Acme pays`);

  await move(M, W, A, T);
  const inT = (await nodesTitled(T, `Kafka${mk}`)).filter((n) => n.node_type === 'decision');
  assert.ok(inT.length >= 1, 'precondition: A took a copy');
  for (const copy of inT) assert.doesNotMatch(copy.summary || '', /BNOTE/, JSON.stringify(inT));
  await share(M, T, A, { visibility: 'shared' });
  const secret = new RegExp(`BNOTE${mk}`);
  assert.doesNotMatch((await recall(m2key, T, `Kafka${mk}`)).text, secret);
  for (const path of [`/api/v1/context/graph/projects/${A}`, '/api/v1/context/workspace/entities?limit=50', '/api/v1/context/graph/export']) {
    const res = await as('get', path, M2, T);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(JSON.stringify(res.body), secret, path);
  }

  // The note stays where it was written, whole.
  const home = (await nodesTitled(W, `Kafka${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(home.length, 1, JSON.stringify(home));
  assert.match(home[0].summary, secret);
  assert.match((await recall(wkey, W, `Kafka${mk}`)).text, secret);
  const bGraph = await as('get', `/api/v1/context/graph/projects/${B}`, M, W);
  assert.match(JSON.stringify(bGraph.body), secret, 'B\'s graph lost its note');
});

test('V1 (a/p5): moving A out of a solo workspace leaves B\'s shared entities whole', async () => {
  const O = await makePerson('s36p5o', { plan: 'developer_pro' });
  const M = await makePerson('s36p5m');
  await join(O, M);
  const T = O.orgId;
  const W = M.orgId;
  const mk = tag();
  const A = await newProject(M, `ApiA${mk}`, W);
  const B = await newProject(M, `SideB${mk}`, W);
  const decs = [`Use Postgres${mk} for billing ledger storage`, `Deploy on Fly${mk} in two regions`];
  const delta = { tech_stack: [`Stripe${mk}`], recent_decisions: decs.map((summary) => ({ summary, decided_at: today() })) };
  await flush(M, W, A, delta);
  await flush(M, W, B, { ...delta, current_task: 'ship B' });
  const graphOfB = async () => {
    const g = (await as('get', `/api/v1/context/graph/projects/${B}`, M, W)).body;
    return (g.nodes || g.graph?.nodes || [])
      .filter((n) => String(n.title).includes(mk) && n.node_type !== 'project')
      .map((n) => [n.title, n.summary || '', n.metadata?.status || null, n.metadata?.memory_tier || null])
      .sort((a, b) => a[0].localeCompare(b[0]));
  };
  const before = await graphOfB();
  assert.equal(before.length, 3, JSON.stringify(before));
  assert.ok(before.every(([, summary]) => summary), JSON.stringify(before));

  await move(M, W, A, T);
  assert.deepEqual(await graphOfB(), before);
});

test('V1 (b/p116): moving B into the team does not take the note another solo project left on its node', async () => {
  const O = await makePerson('s36p116o', { plan: 'developer_pro' });
  const M = await makePerson('s36p116m');
  const M2 = await makePerson('s36p116n');
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const W = M.orgId;
  const mhome = await mintKey(M, W);
  const okey = await mintKey(O, T);
  const m2key = await mintKey(M2, T);
  const mk = tag();
  const B = await newProject(M, `Bill${mk}`, W);
  const A = await newProject(M, `JobHunt${mk}`, W);
  const D = `Decided to move billing to Paddle${mk}.`;
  await flush(M, W, B, { recent_decisions: [{ summary: D, decided_at: today() }], current_task: 'Wire Paddle webhooks' });
  const note = `PRIVNOTE${mk}: because I am interviewing at Paddle next week.`;
  const saved = await upsert(mhome, W, { project_id: A, entities: [{ entity_type: 'decision', title: D, summary: note }] });
  assert.equal(saved.err, false, saved.text);
  const [node] = (await nodesTitled(W, `Paddle${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(node.project_id, B, 'precondition: the node is homed in B');
  await legacyNoteOn(W, node.node_id, note);

  await move(M, W, B, T);
  const secret = new RegExp(`PRIVNOTE${mk}`);
  for (const copy of await nodesTitled(T, `Paddle${mk}`)) assert.doesNotMatch(copy.summary || '', secret);
  assert.doesNotMatch((await recall(okey, T, `Paddle${mk}`)).text, secret, 'the owner reads it without a share');
  await share(M, T, B, { visibility: 'shared' });
  assert.doesNotMatch((await recall(m2key, T, `Paddle${mk}`)).text, secret);
  const graph = await as('get', `/api/v1/context/graph/projects/${B}`, M2, T);
  assert.doesNotMatch(JSON.stringify(graph.body), secret);
  // And the note is still at home, where it was written.
  assert.match((await recall(mhome, W, `Paddle${mk}`)).text, secret);
});

// ── V2. A write in flight when the first invite lands ───────────────────────

test('V2 (a/p3): a flush in flight while the first invite is accepted leaves no cross-project landing', async () => {
  for (const lag of [0, 40, 80, 150, 400]) {
    const F = await makePerson('s36p3f', { plan: 'developer_pro' });
    const W = F.orgId;
    const fkey = await mintKey(F, W);
    const mk = tag();
    const X = await newProject(F, `SecretX${mk}`);
    const Y = await newProject(F, `PublicY${mk}`);
    const decisions = Array.from({ length: 25 }, (_, i) => ({ summary: `Decision ${i} about Thing${mk} number ${i}`, decided_at: today() }));
    const tech = Array.from({ length: 15 }, (_, i) => `Tech${i}x${mk}`);
    await flush(F, W, X, { recent_decisions: decisions, tech_stack: tech });
    const note = await upsert(fkey, W, { project_id: X, entities: [{ entity_type: 'decision', title: `Decision 10 about Thing${mk} number 10`, summary: `XNOTE${mk} secret: negotiating an acquisition with Tech3` }] });
    assert.equal(note.err, false, note.text);
    const M = await makePerson('s36p3m');
    const invite = await workspace.createInvite(W, M.email, { role: 'member', invitedBy: F.userId });
    const inFlight = flushRaw(F, W, Y, { recent_decisions: decisions, tech_stack: tech }).then((r) => r);
    await wait(lag);
    const accepted = await workspace.acceptInvite(invite.token, { id: M.userId, email: M.email });
    assert.ok(accepted.ok, accepted.reason);
    assert.equal((await inFlight).status, 202);
    await wait(300);

    assert.deepEqual(await evidenceCrossing(W, X, Y), [], `lag ${lag}: Y's evidence left on X's nodes`);
    await share(F, W, Y, { visibility: 'shared' });
    const mkey = await mintKey(M, W);
    const secret = new RegExp(`XNOTE${mk}|SecretX${mk}|${X}`);
    assert.doesNotMatch((await recall(mkey, W, `Thing${mk} number 10`)).text, secret, `lag ${lag}`);
    const graph = await as('get', `/api/v1/context/graph/projects/${Y}`, M, W);
    assert.doesNotMatch(JSON.stringify(graph.body), secret, `lag ${lag}`);
  }
});

test('V2 (guard): the split finishes a half-done split and is a no-op after', async () => {
  const F = await makePerson('s36splith', { plan: 'developer_pro' });
  const W = F.orgId;
  const mk = tag();
  const X = await newProject(F, `Xh${mk}`);
  const Y = await newProject(F, `Yh${mk}`);
  const tech = [`Kafka${mk}`, `Redis${mk}`];
  await flush(F, W, X, { tech_stack: tech });
  await flush(F, W, Y, { tech_stack: [tech[0]] });
  assert.ok((await workspace.splitCrossProjectLandings(W)).nodes_copied >= 1);
  // Y's next solo-era write lands on X's other node: a split already ran.
  await flush(F, W, Y, { tech_stack: tech });
  assert.ok((await evidenceCrossing(W, X, Y)).length >= 1, 'precondition: a landing after the split');
  const second = await workspace.splitCrossProjectLandings(W);
  assert.ok(second.evidence_repointed >= 1, JSON.stringify(second));
  assert.deepEqual(await evidenceCrossing(W, X, Y), []);
  const third = await workspace.splitCrossProjectLandings(W);
  assert.deepEqual([third.nodes_copied, third.evidence_repointed, third.edges_repointed, third.edges_merged], [0, 0, 0, 0], JSON.stringify(third));
});

// ── V3. Another project's save never rewrites a node's words ────────────────

test('V3 (b/p114): a solo founder\'s note saved in A onto B\'s node is not B\'s to publish', async () => {
  const F = await makePerson('s36p114f', { plan: 'developer_pro' });
  const M = await makePerson('s36p114m');
  const W = F.orgId;
  const fkey = await mintKey(F, W);
  const mk = tag();
  const B = await newProject(F, `Bill${mk}`);
  const A = await newProject(F, `JobHunt${mk}`);
  // Under 40 characters: the summary the store used to let any save replace.
  const D = `Move billing to Paddle${mk}.`;
  await flush(F, W, B, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Paddle${mk}`], current_task: 'Wire Paddle webhooks' });
  const saved = await upsert(fkey, W, { project_id: A, entities: [
    { title: D, entity_type: 'decision', summary: `PRIVNOTE${mk}: because I am interviewing at Paddle next week.` },
    { title: `Paddle${mk}`, entity_type: 'service', summary: `PRIVSVC${mk}: my recruiter contact is there.` },
  ] });
  assert.equal(saved.err, false, saved.text);
  // Said, not a bare "Upserted": the words were not saved onto B's entity.
  assert.match(saved.text, /Kept the (existing )?description of/, saved.text);
  const rows = await nodesTitled(W, `Paddle${mk}`);
  assert.ok(rows.length >= 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.project_id, B, JSON.stringify(rows));
    assert.doesNotMatch(row.summary || '', /PRIV/, JSON.stringify(rows));
  }

  await join(F, M);
  const mkey = await mintKey(M, W);
  await share(F, W, B, { visibility: 'shared' });
  const secret = new RegExp(`PRIVNOTE${mk}|PRIVSVC${mk}|JobHunt${mk}`);
  assert.doesNotMatch((await recall(mkey, W, `Paddle${mk}`)).text, secret);
  for (const path of [`/api/v1/context/graph/projects/${B}`, '/api/v1/context/workspace/entities?limit=50', '/api/v1/context/graph/export']) {
    const res = await as('get', path, M, W);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(JSON.stringify(res.body), secret, path);
  }
});

test('V3 (guard): a save from the node\'s own project still replaces a short summary', async () => {
  const F = await makePerson('s36v3g', { plan: 'developer_pro' });
  const fkey = await mintKey(F, F.orgId);
  const mk = tag();
  const B = await newProject(F, `Own${mk}`);
  const D = `Decided to use Paddle${mk}.`;
  await flush(F, F.orgId, B, { recent_decisions: [{ summary: D, decided_at: today() }] });
  const saved = await upsert(fkey, F.orgId, { project_id: B, entities: [{ title: D, entity_type: 'decision', summary: `Chosen for merchant-of-record tax handling ${mk}.` }] });
  assert.equal(saved.err, false, saved.text);
  const [row] = (await nodesTitled(F.orgId, `Paddle${mk}`)).filter((n) => n.node_type === 'decision');
  assert.match(row.summary, /merchant-of-record/);
});

// ── V4. Copies keep a node's state, not its words ───────────────────────────

test('V4 (b/p115): a decision resolved in the solo era stays resolved in the first invite\'s copies', async () => {
  const F = await makePerson('s36p115f', { plan: 'developer_pro' });
  const M = await makePerson('s36p115m');
  const W = F.orgId;
  const fkey = await mintKey(F, W);
  const mk = tag();
  const X = await newProject(F, `Api${mk}`);
  const Y = await newProject(F, `Web${mk}`);
  const D = `Decided to drop the GraphQL gateway${mk}.`;
  await flush(F, W, X, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Redis${mk}`] });
  await flush(F, W, Y, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Redis${mk}`] });
  for (const P of [Y, X]) {
    const r = await mcpCall(fkey, W, 'manage_memory', { action: 'resolve', title: D, project_id: P });
    assert.match(r.text, /Marked resolved|resolved/i, r.text);
  }
  assert.doesNotMatch((await recall(fkey, W, `gateway${mk}`)).text, new RegExp(`GraphQL gateway${mk}`), 'precondition: resolved');

  await join(F, M);
  const decisions = (await nodesTitled(W, `gateway${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(decisions.length, 2, JSON.stringify(decisions));
  for (const d of decisions) assert.equal(d.metadata.status, 'resolved', JSON.stringify(decisions));
  assert.doesNotMatch((await recall(fkey, W, `gateway${mk}`)).text, new RegExp(`GraphQL gateway${mk}`));
});

test('V4 (b/p117): the nightly job does not archive the first invite\'s copies of a used, pinned entity', async () => {
  const F = await makePerson('s36p117f', { plan: 'developer_pro' });
  const M = await makePerson('s36p117m');
  const W = F.orgId;
  const fkey = await mintKey(F, W);
  const mk = tag();
  const X = await newProject(F, `Api${mk}`);
  const Y = await newProject(F, `Web${mk}`);
  const D = `Decided to keep all money amounts in integer cents${mk}.`;
  const delta = { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Postgres${mk}`] };
  await flush(F, W, X, delta);
  await flush(F, W, Y, delta);
  const pinned = await upsert(fkey, W, { project_id: X, entities: [{ title: D, entity_type: 'decision', summary: D, metadata: { pinned: true } }] });
  assert.equal(pinned.err, false, pinned.text);
  await q(
    `UPDATE context_graph_nodes SET last_seen_at = NOW() - INTERVAL '60 days', metadata = metadata || '{"retrieval_hits":7}'::jsonb
      WHERE owner_key = $1 AND node_type IN ('decision', 'service') AND title ILIKE $2`,
    [W, `%${mk}%`],
  );
  await join(F, M);
  const copies = (await nodesTitled(W, mk)).filter((n) => n.project_id === Y);
  assert.equal(copies.length, 2, JSON.stringify(copies));
  const decisionCopy = copies.find((n) => n.node_type === 'decision');
  assert.equal(decisionCopy.metadata.pinned, true, JSON.stringify(decisionCopy));
  for (const copy of copies) assert.equal(Number(copy.metadata.retrieval_hits), 7, JSON.stringify(copy));

  const vault = require('../../src/jobs/vaultRemediationJob');
  await vault.runVaultRemediation();
  for (const row of await nodesTitled(W, mk)) {
    assert.notEqual(row.metadata.status, 'archived', JSON.stringify(row));
  }
  // Copies carry state, never words: no summary, no free text.
  const again = (await nodesTitled(W, mk)).filter((n) => n.project_id === Y);
  for (const copy of again) {
    assert.equal(copy.summary, '', JSON.stringify(copy));
    for (const value of Object.values(copy.metadata)) assert.ok(typeof value !== 'string' || !/\s/.test(value), JSON.stringify(copy.metadata));
  }
});

// ── V5. A long decision cannot block the invite ─────────────────────────────

test('V5 (b/p119): an invite with a ~2,600-character shared decision succeeds and the split still separates it', async () => {
  const F = await makePerson('s36p119f', { plan: 'developer_pro' });
  const M = await makePerson('s36p119m');
  const W = F.orgId;
  const mk = tag();
  const X = await newProject(F, `Api${mk}`);
  const Y = await newProject(F, `Web${mk}`);
  let D = `Decided ${mk}`;
  while (D.length < 2600) D += ` ${crypto.randomBytes(6).toString('hex')}`;
  D = `${D.slice(0, 2600)}.`;
  await flush(F, W, X, { recent_decisions: [{ summary: D, decided_at: today() }] });
  await flush(F, W, Y, { recent_decisions: [{ summary: D, decided_at: today() }] });
  const before = (await nodesTitled(W, `Decided ${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(before.length, 1, 'precondition: one node for both projects');
  assert.ok(before[0].canonical_key.length > 2550, `precondition: a long key (${before[0].canonical_key.length})`);
  assert.ok((await evidenceCrossing(W, X, Y)).length >= 1, 'precondition: Y landed on X\'s node');

  await join(F, M);
  const members = (await q('SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL', [W])).rows[0].n;
  assert.equal(members, 2);
  assert.deepEqual(await evidenceCrossing(W, X, Y), []);
  const after = (await nodesTitled(W, `Decided ${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(after.length, 2, JSON.stringify(after.map((n) => [n.project_id, n.canonical_key.length])));
  const copy = after.find((n) => n.project_id === Y);
  assert.ok(copy.canonical_key.length < 1200, `the scoped key is bounded (${copy.canonical_key.length})`);
  // Y's next team-era flush finds its copy again rather than minting a third.
  await flush(F, W, Y, { recent_decisions: [{ summary: D, decided_at: today() }], current_task: 'after the invite' });
  const later = (await nodesTitled(W, `Decided ${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(later.length, 2, JSON.stringify(later.map((n) => [n.project_id, n.canonical_key.length])));
});

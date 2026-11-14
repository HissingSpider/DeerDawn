/**
 * SCAN 16 — PRIVACY: WHAT A TEAMMATE CAN REACH THAT THEY CANNOT READ.
 *
 *   1. GET /shares handed every teammate — a read-only viewer key included — the
 *      TOKEN of every live share link in the workspace, and filtered only the
 *      project NAME printed beside it. The public share page then served a
 *      colleague's personal project to whoever held the token.
 *   2. A project's root graph node was keyed by project NAME, so two teammates'
 *      same-named projects were one row: a personal project's status text was
 *      served to a colleague on every graph-reading surface, and carried out
 *      with them on removal.
 *   3. Share links a removed member minted on projects that STAY with the team
 *      kept serving the live team brief, decisions made after they left included.
 *   4. GET /skills?project_id=<colleague's personal project> listed its skills.
 *   5. An open /stream outlived its reader's removal.
 *   6. A member demoted to viewer could neither edit nor move out their OWN
 *      personal project.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan16-privacy.test.js
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
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const graph = require('../../src/services/contextGraphService');
const contextRoutes = require('../../src/routes/context/context-sync');

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

async function mintKey(person, orgId, scopes) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), scopes],
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
function asKey(method, path, key) {
  return request(httpServer)[method](path).set('Authorization', `Bearer ${key}`);
}

async function createProject(person, ws, name, visibility = null) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.project.project_id;
  if (visibility) {
    const vis = await as('patch', `/api/v1/teams/projects/${id}/sharing`, person, ws).send({ visibility });
    assert.equal(vis.status, 200, `sharing ${visibility}: ${vis.status} ${JSON.stringify(vis.body)}`);
  }
  return id;
}

async function mintShare(person, ws, projectId) {
  const res = await as('post', `/api/v1/context/projects/${projectId}/share`, person, ws).send({ visibility: 'unlisted' });
  assert.equal(res.status, 201, `share create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.share.token;
}

async function team() {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  const V = await makePerson('viewer');
  await join(O, M);
  await join(O, V, 'viewer');
  return { O, M, V, T: O.orgId };
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
async function mcp(key, name, args) {
  const res = await request(httpServer).post('/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return JSON.stringify(body);
}

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: GET /shares lists only links on projects the reader may read — the token is the credential', async () => {
  const { O, M, V, T } = await team();
  const personal = await createProject(M, T, `M side ${uuidv4().slice(0, 6)}`, 'personal');
  const priv = await createProject(M, T, `M billing ${uuidv4().slice(0, 6)}`, 'private');
  const shared = await createProject(M, T, `Team payments ${uuidv4().slice(0, 6)}`, 'shared');
  const oPersonal = await createProject(O, T, `O side ${uuidv4().slice(0, 6)}`, 'personal');
  const tokens = {
    personal: await mintShare(M, T, personal),
    priv: await mintShare(M, T, priv),
    shared: await mintShare(M, T, shared),
    oPersonal: await mintShare(O, T, oPersonal),
  };
  const projectOf = { personal, priv, shared, oPersonal };
  // Which links are LISTED (by project), and which of those hand over the token.
  // Scan 21: listing a link and holding it are different — the token goes only
  // to its author, the project's author and workspace owners.
  const listing = async (person, key = null) => {
    const res = key ? await asKey('get', '/api/v1/context/shares', key) : await as('get', '/api/v1/context/shares', person, T);
    assert.equal(res.status, 200);
    const rows = new Map(res.body.shares.map((s) => [s.project_id, s]));
    const keys = Object.keys(tokens).filter((k) => rows.has(projectOf[k])).sort();
    return { keys, held: keys.filter((k) => rows.get(projectOf[k]).token === tokens[k]), text: JSON.stringify(res.body) };
  };
  const listed = async (person, key = null) => {
    const { keys, held } = await listing(person, key);
    // Everybody below except the viewer holds every link they list.
    if (person !== V) assert.deepEqual(held, keys, `${person.label || 'reader'} holds each link they list`);
    return keys;
  };

  assert.deepEqual(await listed(V), ['shared'], 'a viewer lists the shared project\'s link only');
  const vKey = await mintKey(V, T, ['context:read']);
  assert.deepEqual(await listed(V, vKey), ['shared'], 'and so does a read-only viewer key');
  for (const viewerListing of [await listing(V), await listing(V, vKey)]) {
    assert.deepEqual(viewerListing.held, [], 'a viewer sees that the link exists, never its token');
    assert.ok(!viewerListing.text.includes(tokens.shared));
  }
  assert.deepEqual(await listed(M), ['personal', 'priv', 'shared'], 'the author lists their own links, never the owner\'s personal one');
  assert.deepEqual(await listed(O), ['oPersonal', 'priv', 'shared'], 'an owner reads private work, never a colleague\'s personal work');

  // Every link still resolves for whoever legitimately holds it.
  const page = await request(httpServer).get(`/api/v1/public/content/share/${tokens.personal}`);
  assert.equal(page.status, 200);
});

test('1b: a solo account lists every one of its links, exactly as before', async () => {
  const S = await makePerson('solo', { plan: 'developer_pro' });
  const a = await createProject(S, null, `Solo A ${uuidv4().slice(0, 6)}`);
  const b = await createProject(S, null, `Solo B ${uuidv4().slice(0, 6)}`);
  const ta = await mintShare(S, null, a);
  const tb = await mintShare(S, null, b);
  const res = await as('get', '/api/v1/context/shares', S);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.shares.map((s) => s.token).sort(), [ta, tb].sort());
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('3: removal revokes the links the removed person minted on projects that stay, and says so', async () => {
  const { O, M, T } = await team();
  const personal = await createProject(M, T, `M side ${uuidv4().slice(0, 6)}`, 'personal');
  const shared = await createProject(M, T, `Team payments ${uuidv4().slice(0, 6)}`, 'shared');
  const priv = await createProject(M, T, `M billing ${uuidv4().slice(0, 6)}`, 'private');
  const oShared = await createProject(O, T, `O team ${uuidv4().slice(0, 6)}`, 'shared');
  const tPersonal = await mintShare(M, T, personal);
  const tShared = await mintShare(M, T, shared);
  const tPriv = await mintShare(M, T, priv);
  const tOwner = await mintShare(O, T, oShared);

  const rm = await as('delete', `/api/v1/teams/members/${M.userId}`, O, T);
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(rm.body.personal_projects_moved, 1);
  const revoked = rm.body.share_links_revoked;
  assert.ok(Array.isArray(revoked), 'the removal response names the links it turned off');
  assert.deepEqual(revoked.map((r) => r.project_id).sort(), [priv, shared].sort());
  for (const r of revoked) {
    assert.equal(r.token_prefix.length, 6);
    assert.ok(!Object.values(r).includes(tShared) && !Object.values(r).includes(tPriv), 'never the token itself');
  }

  await as('patch', `/api/v1/context/projects/${shared}/context`, O, T)
    .send({ recent_decisions: [{ summary: 'Decided: POSTREMOVAL acquisition talks', decided_at: new Date().toISOString() }] });
  const page = await request(httpServer).get(`/api/v1/public/content/share/${tShared}`);
  assert.equal(page.status, 410, 'the departed author\'s link no longer serves the team brief');
  assert.equal(page.body.error, 'share_revoked');
  assert.ok(!JSON.stringify(page.body).includes('POSTREMOVAL'));
  assert.equal((await request(httpServer).get(`/api/v1/public/content/share/${tPriv}`)).status, 410);
  assert.equal((await request(httpServer).get(`/api/v1/public/content/share/${tOwner}`)).body.state, 'ok',
    'a link somebody still in the team minted is untouched');
  // The carried project's link went with the carry (deleted, as before).
  assert.equal((await request(httpServer).get(`/api/v1/public/content/share/${tPersonal}`)).status, 404);
});

// ── 2 ────────────────────────────────────────────────────────────────────────

const O_PRE = `OPRE${uuidv4().slice(0, 6)}`;
const M_OWN = `MOWN${uuidv4().slice(0, 6)}`;

async function writeGraph(ownerKey, projectId, { status, stack, decision }) {
  const project = await store.getProject(ownerKey, projectId);
  project.context.current_status = status;
  project.context.tech_stack = stack;
  project.context.recent_decisions = [{ summary: decision, decided_at: new Date().toISOString() }];
  await graph.recordGraphArtifacts({
    ownerKey,
    project,
    session: { session_id: `s-${uuidv4()}`, tool: 'claude_code' },
    input: { chunks: [{ role: 'user', text: decision }] },
  });
}

async function surfaces(person, T, key, projectId) {
  const out = {};
  const get = async (path) => { const r = await as('get', path, person, T); out[path] = JSON.stringify(r.body) + (r.text || ''); };
  const post = async (path, body) => { const r = await as('post', path, person, T).send(body); out[path] = JSON.stringify(r.body); };
  await get(`/api/v1/context/graph/projects/${projectId}`);
  await get('/api/v1/context/workspace/entities');
  await get('/api/v1/context/graph/export');
  await get('/api/v1/context/export');
  await get('/api/v1/context/export?format=markdown');
  await post('/api/v1/context/search', { query: 'Atlas', limit: 20 });
  await post('/api/v1/context/graph/query', { query: 'Atlas', limit: 50 });
  out['mcp:search'] = await mcp(key, 'recall', { action: 'search', query: 'Atlas' });
  out['mcp:entities'] = await mcp(key, 'recall', { action: 'entities' });
  out['mcp:search-marker'] = await mcp(key, 'recall', { action: 'search', query: O_PRE });
  return out;
}

test('2: two teammates\' same-named projects get two root nodes — no status text crosses', async () => {
  const { O, M, T } = await team();
  const name = `Atlas${uuidv4().slice(0, 4)}`;
  const oPre = await createProject(O, T, name, 'personal');
  const mAtlas = await createProject(M, T, name, 'personal');
  // M's written first, so M's project is the old shared row's HOME — the case
  // where the owner's personal text became readable to M.
  await writeGraph(T, mAtlas, { status: `${M_OWN} mia`, stack: ['postgres'], decision: 'Decided: ledger on postgres' });
  await writeGraph(T, oPre, { status: `${O_PRE} founder solo notes`, stack: ['postgres'], decision: 'Decided: founder spike' });

  const mKey = await mintKey(M, T, ['context:read', 'context:write']);
  const seen = await surfaces(M, T, mKey, mAtlas);
  for (const [surface, text] of Object.entries(seen)) {
    assert.ok(!text.includes(O_PRE), `the owner's personal status must not reach M on ${surface}`);
  }
  assert.ok(Object.values(seen).some((t) => t.includes(M_OWN)), 'M still reads their own root');

  const roots = (await q(
    'SELECT canonical_key, project_id, summary FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\' ORDER BY canonical_key',
    [T],
  )).rows;
  assert.deepEqual(roots.map((r) => r.canonical_key).sort(), [`project:${mAtlas}`, `project:${oPre}`].sort());
  for (const r of roots) assert.equal(r.canonical_key, `project:${r.project_id}`);

  // Removal carries only M's own words.
  const rm = await as('delete', `/api/v1/teams/members/${M.userId}`, O, T);
  assert.equal(rm.status, 200);
  const carried = (await q('SELECT summary FROM context_graph_nodes WHERE owner_key = $1', [M.orgId])).rows;
  assert.ok(carried.length > 0);
  assert.ok(!carried.some((r) => String(r.summary || '').includes(O_PRE)), 'removal carries only M\'s own text');
});

test('2b: the one-time repair splits an existing NAME-keyed root and keeps no ambiguous text', async () => {
  const { O, M, T } = await team();
  const name = `legacy${uuidv4().slice(0, 6)}`;
  const oPre = await createProject(O, T, `${name}-o`, 'personal');
  const mProj = await createProject(M, T, `${name}-m`, 'personal');
  const solo = await createProject(O, T, `${name}-solo`, 'shared');
  const now = () => new Date().toISOString();
  const node = (projectId, type, key, summary, metadata = {}) => store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: T, project_id: projectId, node_type: type, canonical_key: key,
    title: name, summary, metadata, confidence: 0.9, source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
  const edge = (projectId, from, to) => store.upsertGraphEdge({
    edge_id: `graph_edge_${uuidv4()}`, owner_key: T, project_id: projectId, edge_type: 'depends_on',
    from_node_id: from, to_node_id: to, summary: 'depends', metadata: {}, confidence: 0.7, source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
  const evidence = (projectId, nodeId, edgeId) => store.addGraphEvidence({
    evidence_id: `ev_${uuidv4()}`, owner_key: T, project_id: projectId, session_id: 's', node_id: nodeId, edge_id: edgeId,
    tool: 'claude_code', excerpt: 'seen', metadata: {}, confidence: 0.8, created_at: now(),
  });
  // The old shape: one `project:<name>` row, home = M's project, summary = O's text.
  const legacy = await node(mProj, 'project', `project:${name}`, `${O_PRE} founder solo notes`,
    { project_id: oPre, tech_stack: ['postgres'] });
  const mine = await node(mProj, 'service', `service:m-${uuidv4().slice(0, 6)}`, 'm svc');
  const theirs = await node(oPre, 'service', `service:o-${uuidv4().slice(0, 6)}`, 'o svc');
  const shared = await node(mProj, 'service', `service:pg-${uuidv4().slice(0, 6)}`, 'postgres');
  const eM = await edge(mProj, legacy.node_id, mine.node_id);
  const eO = await edge(oPre, legacy.node_id, theirs.node_id);
  const eBoth = await edge(mProj, legacy.node_id, shared.node_id); // one edge row, both projects' evidence
  await evidence(mProj, mine.node_id, eM.edge_id);
  await evidence(oPre, theirs.node_id, eO.edge_id);
  await evidence(mProj, shared.node_id, eBoth.edge_id);
  await evidence(oPre, shared.node_id, eBoth.edge_id);
  // And an unambiguous one: its own name, its own project, its own words.
  const soloRoot = await node(solo, 'project', `project:${name}-solo`, 'solo status stays',
    { project_id: solo, tech_stack: [] });
  await edge(solo, soloRoot.node_id, (await node(solo, 'service', `service:s-${uuidv4().slice(0, 6)}`, 's')).node_id);

  const exec = (text, params) => db.query(text, params, 'org-system');
  const stats = await graph.migrateNameKeyedProjectRoots(exec);
  assert.ok(stats.roots >= 2);

  const rootOf = async (projectId) => (await q(
    'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\' AND canonical_key = $2',
    [T, `project:${projectId}`],
  )).rows[0];
  const mRoot = await rootOf(mProj);
  const oRoot = await rootOf(oPre);
  const sRoot = await rootOf(solo);
  assert.ok(mRoot && oRoot && sRoot, 'every project has its own id-keyed root');
  assert.equal(mRoot.node_id, legacy.node_id, 'the home project keeps the row');
  assert.equal(mRoot.summary, '', 'an ambiguous summary is cleared, never assigned to a guess');
  assert.equal(oRoot.summary, '');
  assert.deepEqual(mRoot.metadata.tech_stack, []);
  assert.equal(sRoot.node_id, soloRoot.node_id);
  assert.equal(sRoot.summary, 'solo status stays', 'an unambiguous root keeps its words');
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND canonical_key = $2', [T, `project:${name}`])).rows[0].n, 0);

  const edgesFrom = async (rootId) => (await q(
    'SELECT edge_id, project_id, to_node_id FROM context_graph_edges WHERE owner_key = $1 AND from_node_id = $2', [T, rootId],
  )).rows;
  const mEdges = await edgesFrom(mRoot.node_id);
  const oEdges = await edgesFrom(oRoot.node_id);
  assert.deepEqual(mEdges.map((e) => e.to_node_id).sort(), [mine.node_id, shared.node_id].sort());
  assert.deepEqual(oEdges.map((e) => e.to_node_id).sort(), [theirs.node_id, shared.node_id].sort());
  assert.ok(mEdges.every((e) => e.project_id === mProj) && oEdges.every((e) => e.project_id === oPre));
  // Each project's evidence rides its own project's edge.
  const ev = (await q('SELECT project_id, edge_id FROM context_graph_evidence WHERE owner_key = $1 AND node_id = $2', [T, shared.node_id])).rows;
  for (const row of ev) {
    const owning = row.project_id === mProj ? mEdges : oEdges;
    assert.ok(owning.some((e) => e.edge_id === row.edge_id), 'evidence re-pointed onto its own project\'s edge');
  }

  // M reads nothing of O's text on the graph surfaces.
  const mGraph = await as('get', `/api/v1/context/graph/projects/${mProj}`, M, T);
  assert.ok(!JSON.stringify(mGraph.body).includes(O_PRE));

  const again = await graph.migrateNameKeyedProjectRoots(exec);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\' AND canonical_key <> \'project:\' || project_id', [T])).rows[0].n, 0);
  assert.equal(again.rekeyed + again.split + again.rootsCreated >= 0, true);
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a colleague\'s personal project\'s skills are not listed or loadable', async () => {
  const { M, V, T } = await team();
  const personal = await createProject(M, T, `M side ${uuidv4().slice(0, 6)}`, 'personal');
  const slug = `m-secret-${uuidv4().slice(0, 6)}`;
  await store.upsertWorkspaceSkill({
    skill_id: `skill_${uuidv4()}`, owner_key: T, created_by: M.userId, project_id: personal, slug, name: slug,
    description: 'M private workflow', markdown_content: '# mine', visibility: 'private', enabled: true,
  });
  const vList = await as('get', `/api/v1/context/skills?project_id=${personal}`, V, T);
  assert.equal(vList.status, 200);
  assert.ok(!vList.body.skills.some((s) => s.slug === slug), 'not listed to a teammate who cannot read the project');
  const vGet = await as('get', `/api/v1/context/skills/${slug}`, V, T);
  assert.equal(vGet.status, 404);
  const mList = await as('get', `/api/v1/context/skills?project_id=${personal}`, M, T);
  assert.ok(mList.body.skills.some((s) => s.slug === slug), 'the author still sees it');
  assert.equal((await as('get', `/api/v1/context/skills/${slug}`, M, T)).status, 200);
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test('5: an open stream stops forwarding once its reader is removed', async () => {
  const { O, M, T } = await team();
  const memberActor = { type: 'user', id: M.userId, org_id: M.orgId, workspace_key: T, role: 'admin', scopes: [] };
  const ownerActor = { type: 'user', id: O.userId, org_id: O.orgId, role: 'admin', scopes: [] };
  const memberMay = contextRoutes.createStreamProjectFilter(memberActor, T, { membershipRecheckMs: 0 });
  const ownerMay = contextRoutes.createStreamProjectFilter(ownerActor, T, { membershipRecheckMs: 0 });
  assert.equal(await memberMay('preferences'), true);

  const rm = await as('delete', `/api/v1/teams/members/${M.userId}`, O, T);
  assert.equal(rm.status, 200);
  assert.equal(await memberMay('preferences'), false, 'nothing reaches a removed reader');
  assert.equal(await memberMay(null), false, 'not even a message with no project');
  assert.equal(memberMay.evicted(), true, 'and the route is told to close the stream');
  assert.equal(await ownerMay('preferences'), true, 'the owner\'s stream is unaffected');

  // A solo account with no membership row (predating the backfill) is still admitted.
  const S = await makePerson('solo');
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [S.orgId]);
  const soloMay = contextRoutes.createStreamProjectFilter({ type: 'user', id: S.userId, org_id: S.orgId, role: 'admin', scopes: [] }, S.orgId, { membershipRecheckMs: 0 });
  assert.equal(await soloMay('global'), true);
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: a member demoted to viewer still edits and moves out their OWN personal project, and nothing else', async () => {
  const { O, M, T } = await team();
  const personal = await createProject(M, T, `M diary ${uuidv4().slice(0, 6)}`, 'personal');
  const priv = await createProject(M, T, `M billing ${uuidv4().slice(0, 6)}`, 'private');
  const shared = await createProject(O, T, `Team ${uuidv4().slice(0, 6)}`, 'shared');
  const demote = await as('patch', `/api/v1/teams/members/${M.userId}`, O, T).send({ role: 'viewer' });
  assert.equal(demote.status, 200);

  const own = await as('patch', `/api/v1/context/projects/${personal}/context`, M, T).send({ current_task: 'own personal after demotion' });
  assert.equal(own.status, 200, `own personal: ${own.status} ${JSON.stringify(own.body)}`);
  const teamWrite = await as('patch', `/api/v1/context/projects/${shared}/context`, M, T).send({ current_task: 'viewer write' });
  assert.equal(teamWrite.status, 403, 'the team\'s project stays read-only to a viewer');
  const privWrite = await as('patch', `/api/v1/context/projects/${priv}/context`, M, T).send({ current_task: 'viewer write' });
  assert.equal(privWrite.status, 403, 'an org-owned private project is the team\'s, not the author\'s alone');

  const movePriv = await as('post', `/api/v1/teams/projects/${priv}/move`, M, T).send({ workspace: M.orgId });
  assert.equal(movePriv.status, 403);
  const move = await as('post', `/api/v1/teams/projects/${personal}/move`, M, T).send({ workspace: M.orgId });
  assert.equal(move.status, 200, `move own personal out: ${move.status} ${JSON.stringify(move.body)}`);
  // Putting a project DOWN in a workspace they only read is still refused.
  const back = await as('post', `/api/v1/teams/projects/${personal}/move`, M, M.orgId).send({ workspace: T });
  assert.equal(back.status, 403);
});

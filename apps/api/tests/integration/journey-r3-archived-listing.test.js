/**
 * JOURNEY R3, A1 — THE PRODUCT SENT THE ASSISTANT TO A LISTING THAT SAID THE
 * PERSON HAD NO PROJECTS.
 *
 * After 30 idle days the nightly job archives projects. A person with two
 * projects comes back after five weeks. start_session says, correctly, "2
 * archived projects are waiting, not gone: Ledger Dashboard, Ledger API ...
 * call recall(action:"projects") for the IDs." The assistant does as told, and
 * recall(action:"projects") answered "No projects yet. Use manage_projects with
 * action "create" to create one." An assistant that follows THAT creates a new,
 * empty project beside the archived one, and the session starts cold: the one
 * thing the product exists to prevent.
 *
 * The listing now names archived projects, marked archived, with their ids and
 * the restore call; its structuredContent carries the same facts. It lists an
 * archived project only to somebody who could read it if it were live — the
 * live listing's own scope and share-policy check, not a copy of them — which
 * the team test below pins for an owner, a member and a viewer across personal,
 * private and shared projects, a shared one whose sharing was switched off, and
 * a shared one narrowed to one section.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-archived-listing.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);

const db = require('../../src/config/db');
const { generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const { runAutoArchive } = require('../../src/jobs/autoArchiveJob');

const q = (sql, params) => db.query(sql, params, 'org-system');
const createdOrgs = new Set();

test.after(async () => {
  for (const orgId of createdOrgs) {
    for (const sql of [
      'DELETE FROM context_audit_logs WHERE owner_key = $1',
      'DELETE FROM context_graph_evidence WHERE owner_key = $1',
      'DELETE FROM context_graph_edges WHERE owner_key = $1',
      'DELETE FROM context_graph_nodes WHERE owner_key = $1',
      'DELETE FROM context_sessions WHERE owner_key = $1',
      'DELETE FROM context_projects WHERE owner_key = $1',
      'DELETE FROM workspace_members WHERE owner_key = $1',
      'DELETE FROM workspace_invites WHERE owner_key = $1',
      'DELETE FROM workspace_ownership_backfills WHERE owner_key = $1',
    ]) await q(sql, [orgId]).catch(() => {});
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

// A separate org per person, always: the org plan cache holds for 300s.
async function makePerson(label, { plan = 'free', orgName = null } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@journey-r3.test`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, orgName || `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  await q('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [userId, email, 'admin', orgId]);
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  createdOrgs.add(orgId);
  return { label, orgId, userId, email, key, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin', email }) };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

let rpcId = 1;
async function mcp(person, ws, name, args = {}) {
  let r = request(httpServer).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('x-api-key', person.key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  const res = await r.send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    status: res.status,
    text: (body.result?.content || []).map((b) => b.text).join('\n\n') || JSON.stringify(body.error || body),
    isError: body.result?.isError === true || Boolean(body.error),
    data: body.result?.structuredContent,
  };
}

async function createProject(person, ws, name, summary) {
  const created = await mcp(person, ws, 'manage_projects', { action: 'create', project_name: name });
  assert.equal(created.isError, false, created.text);
  const id = created.data.project_id;
  if (summary) {
    const saved = await mcp(person, ws, 'manage_memory', { action: 'update', project_id: id, summary });
    assert.equal(saved.isError, false, saved.text);
  }
  return id;
}

// What the walker did to the whole database, for one workspace: every clock the
// nightly job reads (writes, reads by a bound session, briefs delivered) moved
// back five weeks.
const FIVE_WEEKS = '35 days';
async function fiveWeeksPass(ownerKey) {
  await q('UPDATE context_projects SET updated_at = updated_at - $2::interval WHERE owner_key = $1', [ownerKey, FIVE_WEEKS]);
  await q('UPDATE context_sessions SET last_seen_at = last_seen_at - $2::interval WHERE owner_key = $1 AND last_seen_at IS NOT NULL', [ownerKey, FIVE_WEEKS]);
  await db.query('UPDATE product_events SET created_at = created_at - $2::interval WHERE org_id = $1', [ownerKey, FIVE_WEEKS], ownerKey);
}

const ids = (text) => [...String(text).matchAll(/\((project_[0-9a-f-]+)\)/g)].map((m) => m[1]);

test('A1: the walker\'s return — the listing the notice points to gives the ids, and following it restores the memory', async () => {
  const P = await makePerson('returner');
  const api = await createProject(P, null, 'Ledger API', 'Decision: amounts are stored as integer minor units with an ISO 4217 currency code.');
  const dash = await createProject(P, null, 'Ledger Dashboard', 'Decision: the dashboard reads balances from the API only.');

  await fiveWeeksPass(P.orgId);
  await runAutoArchive();
  const archivedRows = await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND archived_at IS NOT NULL', [P.orgId]);
  assert.equal(archivedRows.rows.length, 2, 'the nightly job archived both projects');

  // Day 35. The brief, exactly as the walker saw it.
  const opened = await mcp(P, null, 'start_session', {});
  assert.match(opened.text, /2 archived projects are waiting, not gone/);
  assert.match(opened.text, /call recall\(action:"projects"\) for the IDs/);

  // The assistant does as told.
  const listed = await mcp(P, null, 'recall', { action: 'projects' });
  assert.equal(listed.isError, false, listed.text);
  assert.doesNotMatch(listed.text, /No projects yet/, 'THE BUG: the listing says there are no projects');
  assert.doesNotMatch(listed.text, /action "create" to create one/, 'THE BUG: the listing sends the assistant to create one');
  assert.match(listed.text, /^No active projects\. 2 archived projects are waiting, not gone:/);
  assert.ok(listed.text.includes(`• Ledger API (${api}) — archived `), listed.text);
  assert.ok(listed.text.includes(`• Ledger Dashboard (${dash}) — archived `), listed.text);
  assert.ok(listed.text.includes('manage_projects(action:"restore", project_id:"<id>")'), 'it says how to restore one');
  assert.ok(listed.text.includes('rather than creating a new project'), 'it says not to start a new, empty one');

  // structuredContent: the same facts, in the shape the reply already had.
  assert.deepEqual(listed.data.projects, [], 'no live projects');
  assert.equal(listed.data.archived_total, 2);
  assert.deepEqual(new Set(listed.data.archived_projects.map((p) => p.project_id)), new Set([api, dash]));
  for (const row of listed.data.archived_projects) {
    assert.equal(row.archived, true);
    assert.ok(listed.text.includes(`${row.project_name} (${row.project_id})`), `the text names ${row.project_name} as the structured half does`);
    assert.ok(Date.parse(row.archived_at), 'archived_at is a timestamp');
  }
  assert.deepEqual(ids(listed.text).sort(), [api, dash].sort(), 'the text gives exactly the archived ids');

  // Following the listing: restore by the id it printed.
  const idFromListing = /Ledger API \((project_[0-9a-f-]+)\)/.exec(listed.text)[1];
  const restored = await mcp(P, null, 'manage_projects', { action: 'restore', project_id: idFromListing });
  assert.equal(restored.isError, false, restored.text);
  assert.equal(restored.text, 'Restored "Ledger API" from the archive.');

  // Live and archived, each where it belongs.
  const after = await mcp(P, null, 'recall', { action: 'projects' });
  assert.ok(after.text.startsWith(`• Ledger API (${api})\n\nArchived, not gone (1):\n• Ledger Dashboard (${dash}) — archived `), after.text);
  assert.ok(after.text.includes(`manage_projects(action:"restore", project_id:"${dash}")`), 'one archived project: its own id is in the restore call');
  assert.deepEqual(after.data.projects.map((p) => p.project_id), [api]);
  assert.deepEqual(after.data.archived_projects.map((p) => p.project_id), [dash]);

  // The memory came back, and nothing new and empty was created beside it.
  const resumed = await mcp(P, null, 'start_session', {});
  assert.match(resumed.text, /Ledger API/);
  assert.match(resumed.text, /integer minor units/);
  const all = await q('SELECT count(*)::int AS n FROM context_projects WHERE owner_key = $1', [P.orgId]);
  assert.equal(all.rows[0].n, 2, 'no new project was created');
});

test('A1: one archived project, and nobody told "No projects yet" who has any', async () => {
  const P = await makePerson('single');
  const notes = await createProject(P, null, 'Solo Notes', 'Decision: notes are plain markdown files, one per day.');
  await store.setProjectArchived(P.orgId, notes, new Date().toISOString());

  const opened = await mcp(P, null, 'start_session', {});
  assert.ok(opened.text.includes(`project_id:"${notes}"`), 'the notice prints the one id, as before');
  const listed = await mcp(P, null, 'recall', { action: 'projects' });
  assert.ok(listed.text.startsWith(`No active projects. 1 archived project is waiting, not gone:\n• Solo Notes (${notes}) — archived `), listed.text);
  assert.ok(listed.text.includes(`manage_projects(action:"restore", project_id:"${notes}")`));
  assert.deepEqual(listed.data.archived_projects.map((p) => p.project_id), [notes]);
  assert.equal(listed.data.archived_total, 1);

  // Somebody with nothing at all is still told exactly what they were told.
  const E = await makePerson('empty');
  const empty = await mcp(E, null, 'recall', { action: 'projects' });
  assert.equal(empty.text, 'No projects yet. Use manage_projects with action "create" to create one.');
  assert.deepEqual(empty.data, { projects: [] });
});

test('A1 neighbour: the notice and the listing it points to count the same archived projects', async () => {
  // The notice was fed the feed's default page of 10, and counts what it is
  // given: "10 archived projects" to somebody the listing shows 14.
  const P = await makePerson('many');
  const made = [];
  for (let i = 0; i < 14; i += 1) {
    const created = await mcp(P, null, 'manage_projects', { action: 'create', project_name: `Archive Count ${i}` });
    assert.equal(created.isError, false, created.text);
    made.push(created.data.project_id);
    await store.setProjectArchived(P.orgId, created.data.project_id, new Date(Date.UTC(2026, 7, 1 + i)).toISOString());
  }
  const opened = await mcp(P, null, 'start_session', {});
  assert.match(opened.text, /14 archived projects are waiting, not gone/, opened.text.slice(0, 300));
  const listed = await mcp(P, null, 'recall', { action: 'projects' });
  assert.match(listed.text, /^No active projects\. 14 archived projects are waiting, not gone:/);
  assert.equal(listed.data.archived_total, 14);
  assert.deepEqual(new Set(ids(listed.text)), new Set(made));
});

test('A1 visibility: an archived project is listed only to somebody who could read it live (owner, member, viewer)', async () => {
  const tag = uuidv4().slice(0, 8);
  const O = await makePerson('owner', { plan: 'developer_pro', orgName: `Archive Team ${tag}` });
  const M = await makePerson('member');
  const V = await makePerson('viewer');
  const X = await makePerson('outsider');
  await join(O, M, 'member');
  await join(O, V, 'viewer');
  const ws = O.orgId;

  const NAMES = {
    shared: `Team Shared ${tag}`,
    narrow: `Team Narrow ${tag}`,
    oPersonal: `O Personal ${tag}`,
    oUnshared: `O Unshared ${tag}`,
    mPersonal: `M Personal ${tag}`,
    mPrivate: `M Private ${tag}`,
  };
  const p = {};
  p.shared = await createProject(O, ws, NAMES.shared, 'Decision: the team ships on Thursdays.');
  p.narrow = await createProject(O, ws, NAMES.narrow, 'Current task: NARROW-TASK-WITHHELD reconcile the ledgers.');
  p.oPersonal = await createProject(O, ws, NAMES.oPersonal, 'Decision: OWNER-PERSONAL note.');
  p.oUnshared = await createProject(O, ws, NAMES.oUnshared, 'Decision: sharing was switched off for this one.');
  p.mPersonal = await createProject(M, ws, NAMES.mPersonal, 'Decision: MEMBER-PERSONAL resignation plan.');
  p.mPrivate = await createProject(M, ws, NAMES.mPrivate, 'Decision: member private, org-owned.');

  const rows = await q('SELECT project_id, owner_user_id, visibility FROM context_projects WHERE owner_key = $1', [ws]);
  const author = Object.fromEntries(rows.rows.map((r) => [r.project_id, r.owner_user_id]));
  assert.equal(author[p.mPersonal], M.userId, 'M authored their projects');
  assert.equal(author[p.oPersonal], O.userId, 'O authored theirs');

  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [p.oPersonal, 'personal']);
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [p.mPersonal, 'personal']);
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [p.mPrivate, 'private']);
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [p.shared, 'shared']);
  // Shared, narrowed to one section: listed, and its withheld task never travels.
  const narrowed = await request(httpServer).patch(`/api/v1/teams/projects/${p.narrow}/sharing`)
    .set('Authorization', `Bearer ${O.jwt}`).set('x-deerdawn-workspace', ws)
    .send({ visibility: 'shared', sections: [{ section_key: 'recent_decisions', can_view: true, can_edit: false }] });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
  // Shared by visibility, with an explicit share row switched off (legacy data):
  // the live listing hides it from everybody but its author.
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [p.oUnshared, 'shared']);
  await store.upsertProjectShare(p.oUnshared, { org_id: ws, enabled: false, created_by: O.userId, updated_by: O.userId });

  const name = Object.fromEntries(Object.entries(p).map(([k, id]) => [id, k]));
  const expected = {
    owner: ['shared', 'narrow', 'oPersonal', 'oUnshared', 'mPrivate'],
    member: ['shared', 'narrow', 'mPersonal', 'mPrivate'],
    viewer: ['shared', 'narrow'],
  };
  const people = { owner: O, member: M, viewer: V };
  const labels = (list) => list.map((id) => name[id] || id).sort();

  // What each person's LIVE listing shows, before anything is archived.
  const live = {};
  for (const [who, person] of Object.entries(people)) {
    const listed = await mcp(person, ws, 'recall', { action: 'projects' });
    assert.equal(listed.isError, false, listed.text);
    live[who] = labels(listed.data.projects.map((row) => row.project_id));
    assert.deepEqual(live[who], [...expected[who]].sort(), `${who}'s live listing`);
  }

  // Five weeks later, all of it archived.
  for (const id of Object.values(p)) await store.setProjectArchived(ws, id, new Date().toISOString());

  const hiddenFrom = (who) => Object.keys(p).filter((k) => !expected[who].includes(k));

  // The start_session notice first, for everybody: it is what sends them to the
  // listing, and it read the archived feed before the listing did. It used the
  // store's SQL filter alone, so a shared project whose sharing was switched off
  // (hidden from the member's LIVE listing) was named to the member here.
  for (const [who, person] of Object.entries(people)) {
    const opened = await mcp(person, ws, 'start_session', {});
    for (const k of hiddenFrom(who)) {
      assert.ok(!opened.text.includes(NAMES[k]), `${who}'s notice names ${k}, which ${who} cannot read live`);
      assert.ok(!opened.text.includes(p[k]), `${who}'s notice gives the id of ${k}`);
    }
    assert.match(opened.text, new RegExp(`${live[who].length} archived projects are waiting, not gone`), `${who}'s notice counts what the listing lists`);
  }

  for (const [who, person] of Object.entries(people)) {
    const hidden = hiddenFrom(who);
    const listed = await mcp(person, ws, 'recall', { action: 'projects' });
    assert.equal(listed.isError, false, listed.text);
    assert.doesNotMatch(listed.text, /No projects yet/, `THE BUG: ${who} is told there are no projects`);
    const structured = labels(listed.data.archived_projects.map((row) => row.project_id));
    assert.deepEqual(structured, live[who], `${who}'s archived listing names exactly what their live listing showed`);
    assert.deepEqual(labels(ids(listed.text)), live[who], `${who}'s archived listing TEXT names exactly the same`);
    assert.equal(listed.data.archived_total, live[who].length);
    assert.ok(listed.text.startsWith(`No active projects. ${live[who].length} archived projects are waiting, not gone:`), listed.text);

    // Nothing this person may not read, by name or by id, in either half.
    const whole = `${listed.text}\n${JSON.stringify(listed.data)}`;
    for (const k of hidden) {
      assert.ok(!whole.includes(p[k]), `${who} was handed the id of ${k}`);
      assert.ok(!whole.includes(NAMES[k]), `${who} was handed the name of ${k}`);
    }
    assert.ok(!whole.includes('NARROW-TASK-WITHHELD'), `${who}: a withheld section travelled in the archived listing`);
  }

  // Workspace membership: somebody who is not a member reads none of it.
  const outsider = await mcp(X, ws, 'recall', { action: 'projects' });
  const outsiderWhole = `${outsider.text}\n${JSON.stringify(outsider.data || {})}`;
  for (const id of Object.values(p)) assert.ok(!outsiderWhole.includes(id), 'an outsider was handed a team project id');
  assert.ok(!outsiderWhole.includes(tag), 'an outsider was handed a team project name');
});

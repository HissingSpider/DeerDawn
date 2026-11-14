/**
 * JOURNEY SCAN ROUND 6: WHO MAY DELETE, ARCHIVE, MOVE, SHARE OR RENAME A
 * COLLEAGUE'S PROJECT.
 *
 * Owner decisions:
 *
 *   1. A colleague's PRIVATE project (org-owned, not shared with the team): only
 *      its AUTHOR may delete, archive, move (re-parent) or share it while they are
 *      a member. A workspace owner may READ it, and may do those things once the
 *      author has left the workspace (the same fact holdsAuthorRights reads for a
 *      shared project).
 *   2. Only a SHARED project's author or a workspace owner may RENAME it. A
 *      member with edit rights on the project's sections may not.
 *
 * Driven through the REST routes the dashboard uses and through the hosted MCP
 * endpoint (manage_projects). The local MCP server reaches the same service
 * through the same REST routes.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/journey-r6-project-powers.test.js
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

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
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

const tag = () => uuidv4().slice(0, 8);

// A team of three in the owner's workspace: Ann owns it, Lee and Mia are members.
async function makeTeam(label) {
  const ann = await makePerson(`${label}-ann`, { plan: 'developer_pro' });
  const lee = await makePerson(`${label}-lee`);
  const mia = await makePerson(`${label}-mia`);
  await join(ann, lee);
  await join(ann, mia);
  return { ann, lee, mia, ws: ann.orgId };
}

async function createProject(person, ws, name, visibility) {
  const made = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: 'x' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.project_id;
  if (visibility) {
    const set = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  return projectId;
}

async function stored(projectId) {
  const res = await q('SELECT project_name, visibility, parent_project_id, archived_at FROM context_projects WHERE project_id = $1', [projectId]);
  return res.rows[0] || null;
}

// The five things the decision covers, each as one REST request by `person`.
const powers = (projectId, umbrellaId) => ({
  archive: (person, ws) => as('post', `/api/v1/context/projects/${projectId}/archive`, person, ws).send({}),
  restore: (person, ws) => as('post', `/api/v1/context/projects/${projectId}/archive`, person, ws).send({ unarchive: true }),
  move: (person, ws) => as('post', `/api/v1/context/projects/${projectId}/parent`, person, ws).send({ parent_project_id: umbrellaId }),
  share: (person, ws) => as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility: 'shared' }),
  rename: (person, ws, name) => as('post', `/api/v1/context/projects/${projectId}/rename`, person, ws).send({ project_name: name }),
  remove: (person, ws) => as('delete', `/api/v1/context/projects/${projectId}`, person, ws),
});

async function mcpKey(person, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'connector', person.userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function callTool(key, name, args = {}) {
  const res = await request(httpServer)
    .post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', key)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  const body = res.body && Object.keys(res.body).length ? res.body : JSON.parse(line ? line.slice(6) : res.text);
  const text = body.result?.content?.[0]?.text || body.error?.message || '';
  const failed = Boolean(body.error) || body.result?.isError === true;
  return { failed, text, body };
}

test('a workspace owner cannot delete, archive, move, share or rename a colleague\'s private project while the colleague is a member', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp1');
  const T = tag();
  const umbrella = await createProject(ann, ws, `Umbrella ${T}`, 'shared');
  const projectId = await createProject(lee, ws, `Lee private ${T}`, 'private');
  const p = powers(projectId, umbrella);

  // Ann may READ it (the state exists so an owner can reach org work) ...
  const read = await as('get', '/api/v1/context/export?format=json', ann, ws);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok((read.body.projects || []).some((entry) => entry.project_id === projectId), 'precondition: the owner can read a private project');

  // ... and may not use any of the five powers over it.
  const refused = {
    archive: await p.archive(ann, ws),
    move: await p.move(ann, ws),
    share: await p.share(ann, ws),
    rename: await p.rename(ann, ws, `Ann renamed ${T}`),
    remove: await p.remove(ann, ws),
  };
  for (const [power, res] of Object.entries(refused)) {
    assert.equal(res.status, 403, `${power}: an owner is refused on a member's private project (got ${res.status} ${JSON.stringify(res.body)})`);
  }
  // Nothing moved.
  const after = await stored(projectId);
  assert.ok(after, 'the project is still there');
  assert.equal(after.archived_at, null);
  assert.equal(after.parent_project_id, null);
  assert.equal(after.visibility, 'private');
  assert.equal(after.project_name, `Lee private ${T}`);

  // A member who is not the author cannot even see it.
  for (const [power, res] of Object.entries({
    archive: await p.archive(mia, ws),
    remove: await p.remove(mia, ws),
    share: await p.share(mia, ws),
    rename: await p.rename(mia, ws, 'Mia renamed'),
  })) {
    assert.equal(res.status, 404, `${power}: a colleague who cannot see it is answered as though it is not there`);
  }
});

test('the author of a private project keeps every one of those powers', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp2');
  const T = tag();
  const umbrella = await createProject(ann, ws, `Umbrella ${T}`, 'shared');
  const projectId = await createProject(lee, ws, `Lee own ${T}`, 'private');
  const p = powers(projectId, umbrella);

  assert.equal((await p.rename(lee, ws, `Lee renamed ${T}`)).status, 200);
  assert.equal((await p.move(lee, ws)).status, 200);
  assert.equal((await p.archive(lee, ws)).status, 200);
  assert.equal((await p.restore(lee, ws)).status, 200);
  assert.equal((await p.share(lee, ws)).status, 200);
  assert.equal((await p.remove(lee, ws)).status, 200);
  assert.equal(await stored(projectId), null);
});

test('once the author has left, a workspace owner may archive, move, share, rename and delete their private project', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp3');
  const T = tag();
  const umbrella = await createProject(ann, ws, `Umbrella ${T}`, 'shared');
  const projectId = await createProject(lee, ws, `Lee left ${T}`, 'private');
  const p = powers(projectId, umbrella);

  assert.equal((await p.archive(ann, ws)).status, 403, 'precondition: refused while Lee is a member');

  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ws);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.equal((await p.rename(ann, ws, `Ann renamed ${T}`)).status, 200, 'rename');
  assert.equal((await p.move(ann, ws)).status, 200, 'move');
  assert.equal((await p.archive(ann, ws)).status, 200, 'archive');
  assert.equal((await p.restore(ann, ws)).status, 200, 'restore');
  assert.equal((await p.share(ann, ws)).status, 200, 'share');
  assert.equal((await stored(projectId)).visibility, 'shared');
  assert.equal((await p.remove(ann, ws)).status, 200, 'delete');
  assert.equal(await stored(projectId), null);
});

test('a private project of somebody who left stays out of reach of a member', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp4');
  const T = tag();
  const projectId = await createProject(lee, ws, `Lee left member ${T}`, 'private');
  await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ws);
  const p = powers(projectId, null);
  assert.equal((await p.remove(mia, ws)).status, 404);
  assert.equal((await p.archive(mia, ws)).status, 404);
  assert.ok(await stored(projectId), 'the project is untouched');
});

test('only a shared project\'s author or a workspace owner may rename it, not a member with edit rights', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp5');
  const T = tag();
  const projectId = await createProject(lee, ws, `Lee shared ${T}`, 'shared');
  const p = powers(projectId, null);

  // Mia can write into the shared brief ...
  const wrote = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ws).send({ current_status: `MIA${T} status` });
  assert.equal(wrote.status, 200, `precondition: a member edits the shared brief: ${JSON.stringify(wrote.body)}`);

  // ... and may not rename it, from either route the dashboard has.
  const viaRename = await p.rename(mia, ws, `Mia renamed ${T}`);
  assert.equal(viaRename.status, 403, `rename route: ${JSON.stringify(viaRename.body)}`);
  const viaPatch = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ws).send({ project_name: `Mia patched ${T}` });
  assert.equal(viaPatch.status, 403, `context route: ${JSON.stringify(viaPatch.body)}`);
  assert.equal((await stored(projectId)).project_name, `Lee shared ${T}`);

  // The owner and the author may.
  assert.equal((await p.rename(ann, ws, `Ann renamed ${T}`)).status, 200);
  assert.equal((await stored(projectId)).project_name, `Ann renamed ${T}`);
  assert.equal((await p.rename(lee, ws, `Lee renamed ${T}`)).status, 200);
  assert.equal((await stored(projectId)).project_name, `Lee renamed ${T}`);
});

test('the hosted MCP manage_projects follows the same rules', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp6');
  const T = tag();
  const umbrella = await createProject(ann, ws, `Umbrella ${T}`, 'shared');
  const privateId = await createProject(lee, ws, `Lee private ${T}`, 'private');
  const sharedId = await createProject(lee, ws, `Lee shared ${T}`, 'shared');
  const annKey = await mcpKey(ann, ws);
  const miaKey = await mcpKey(mia, ws);
  const leeKey = await mcpKey(lee, ws);

  const archive = await callTool(annKey, 'manage_projects', { action: 'archive', project_id: privateId });
  assert.ok(archive.failed, `an owner archiving a member's private project is refused: ${archive.text}`);
  assert.match(archive.text, /private|author/i, archive.text);
  const move = await callTool(annKey, 'manage_projects', { action: 'move', project_id: privateId, parent_project_id: umbrella });
  assert.ok(move.failed, `and moving it: ${move.text}`);
  assert.equal((await stored(privateId)).archived_at, null);
  assert.equal((await stored(privateId)).parent_project_id, null);

  const memberRename = await callTool(miaKey, 'manage_projects', { action: 'rename', project_id: sharedId, project_name: `Mia renamed ${T}` });
  assert.ok(memberRename.failed, `a member renaming a shared project is refused: ${memberRename.text}`);
  assert.equal((await stored(sharedId)).project_name, `Lee shared ${T}`);

  const ownerRename = await callTool(annKey, 'manage_projects', { action: 'rename', project_id: sharedId, project_name: `Ann renamed ${T}` });
  assert.equal(ownerRename.failed, false, ownerRename.text);
  const authorRename = await callTool(leeKey, 'manage_projects', { action: 'rename', project_id: sharedId, project_name: `Lee renamed ${T}` });
  assert.equal(authorRename.failed, false, authorRename.text);

  const authorArchive = await callTool(leeKey, 'manage_projects', { action: 'archive', project_id: privateId });
  assert.equal(authorArchive.failed, false, authorArchive.text);
  const authorRestore = await callTool(leeKey, 'manage_projects', { action: 'restore', project_id: privateId });
  assert.equal(authorRestore.failed, false, authorRestore.text);
});


test('once the author has left, an owner holds their EDIT rights on a private project too; before that, and for a member, nothing changes', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp7');
  const T = tag();
  const projectId = await createProject(lee, ws, `Lee private edit ${T}`, 'private');
  const edit = (person, body) => as('patch', `/api/v1/context/projects/${projectId}/context`, person, ws).send(body);
  const body = () => ({ current_status: `STATUS${T}`, recent_decisions: [{ summary: `DECISION${T} keep the queue`, decided_at: new Date().toISOString() }], add_todos: [{ title: `CARD${T}`, phase: 'backlog' }], open_questions: [`QUESTION${T}?`] });

  // While Lee is a member the owner reads and does not rewrite; a member cannot see it.
  const refused = await edit(ann, body());
  assert.equal(refused.status, 403, `an owner may not edit a member's private project: ${JSON.stringify(refused.body)}`);
  assert.equal((await edit(mia, body())).status, 404, 'a member never gets it');

  await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ws);

  assert.equal((await edit(mia, body())).status, 404, 'a member still never gets it after the author leaves');
  const written = await edit(ann, body());
  assert.equal(written.status, 200, `the owner holds the author's edit rights: ${JSON.stringify(written.body)}`);
  const exported = await as('get', '/api/v1/context/export?format=json', ann, ws);
  const stored = JSON.stringify((exported.body.projects || []).find((p) => p.project_id === projectId)?.context || {});
  for (const text of [`STATUS${T}`, `DECISION${T}`, `CARD${T}`, `QUESTION${T}`]) assert.ok(stored.includes(text), `"${text}" was written`);
  // ... and can take a note back out, as on a shared project.
  const cleared = await edit(ann, { recent_decisions: [], open_questions: [], remove_todos: [`CARD${T}`] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});

test('a colleague\'s PERSONAL project is never opened, before or after the author leaves', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp8');
  const T = tag();
  const projectId = await createProject(lee, ws, `Lee personal ${T}`, 'personal');
  const res = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ current_status: `X${T}` });
  assert.equal(res.status, 404);
});


// "The author has left" is "the author has no ACTIVE membership in this workspace":
// not only a roster row with removed_at, which an erased account (every roster row
// hard-deleted) and a legacy project stamped with a key id never have.
test('an author whose account was erased no longer holds their private project: the owner can act', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp9');
  const T = tag();
  const privateId = await createProject(lee, ws, `Erased private ${T}`, 'private');
  const sharedId = await createProject(lee, ws, `Erased shared ${T}`, 'shared');
  const personalId = await createProject(lee, ws, `Erased personal ${T}`, 'personal');
  const powersOf = powers(privateId, null);

  assert.equal((await powersOf.archive(ann, ws)).status, 403, 'precondition: refused while Lee is active');
  await as('post', '/api/v1/context/events', lee, ws).send({ event_type: 'decision_made', project_id: sharedId, summary: `LEEDEC${T} keep the queue` });

  // The account erasure: every roster row for the person is deleted, none is marked removed.
  await q('DELETE FROM workspace_members WHERE user_id = $1', [lee.userId]);

  assert.equal((await powersOf.archive(ann, ws)).status, 200, 'archive');
  assert.equal((await powersOf.restore(ann, ws)).status, 200, 'restore');
  assert.equal((await powersOf.share(ann, ws)).status, 200, 'share');
  assert.equal((await powersOf.rename(ann, ws, `Ann renamed ${T}`)).status, 200, 'rename');
  const edited = await as('patch', `/api/v1/context/projects/${privateId}/context`, ann, ws).send({ current_status: `ANN${T}` });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  // Round 5's rights on a SHARED project follow the same definition: Lee's decision can be taken out.
  const cleared = await as('patch', `/api/v1/context/projects/${sharedId}/context`, ann, ws).send({ recent_decisions: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const exported = await as('get', '/api/v1/context/export?format=json', ann, ws);
  const shared = (exported.body.projects || []).find((p) => p.project_id === sharedId);
  assert.ok(!JSON.stringify(shared?.context || {}).includes(`LEEDEC${T}`), 'the erased author\'s decision is gone');
  assert.equal((await powers(privateId, null).remove(ann, ws)).status, 200, 'delete');

  // A personal project is never opened, erased author or not.
  assert.equal((await as('patch', `/api/v1/context/projects/${personalId}/context`, ann, ws).send({ current_status: 'x' })).status, 404);
  assert.equal((await powers(personalId, null).remove(ann, ws)).status, 404);
});

test('an author whose account was erased: the sharing route follows the same definition', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp10');
  const projectId = await createProject(lee, ws, `Erased sharing ${uuidv4().slice(0, 6)}`, 'private');
  assert.equal((await powers(projectId, null).share(ann, ws)).status, 403);
  await q('DELETE FROM workspace_members WHERE user_id = $1', [lee.userId]);
  assert.equal((await powers(projectId, null).share(ann, ws)).status, 200);
});

test('a legacy private project stamped with an unknown owner id is its solo owner\'s to archive and delete', async () => {
  const ann = await makePerson('r6pp11');
  const projectId = await createProject(ann, null, `Legacy ${uuidv4().slice(0, 6)}`, null);
  await q('UPDATE context_projects SET owner_user_id = $2, visibility = $3 WHERE project_id = $1', [projectId, `key-legacy-${uuidv4()}`, 'private']);
  const p = powers(projectId, null);
  assert.equal((await p.archive(ann, null)).status, 200, 'archive');
  assert.equal((await p.restore(ann, null)).status, 200, 'restore');
  assert.equal((await p.remove(ann, null)).status, 200, 'delete');
  assert.equal(await stored(projectId), null);
});

test('an author who is still an active member keeps their private project from the owner', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp12');
  const projectId = await createProject(lee, ws, `Active ${uuidv4().slice(0, 6)}`, 'private');
  const p = powers(projectId, null);
  assert.equal((await p.archive(ann, ws)).status, 403);
  assert.equal((await p.remove(ann, ws)).status, 403);
  assert.equal((await p.share(ann, ws)).status, 403);
  assert.ok(await stored(projectId));
});


// A project or entry stamped BEFORE the identity fix carries the author's KEY id,
// not their user id. "Left" is judged on the person the key belongs to.
async function keyFor(person, orgId) {
  const { prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, prefix, hash, 'legacy', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return keyId;
}

test('a private project stamped with an ACTIVE member\'s key id is that member\'s: the owner is refused until they leave', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp13');
  const T = tag();
  const projectId = await createProject(lee, ws, `Key stamped ${T}`, 'private');
  const keyId = await keyFor(lee, ws);
  await q('UPDATE context_projects SET owner_user_id = $2 WHERE project_id = $1', [projectId, keyId]);
  const p = powers(projectId, null);
  const edit = () => as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ current_status: `ANN${T}` });

  assert.equal((await p.archive(ann, ws)).status, 403, 'archive');
  assert.equal((await p.remove(ann, ws)).status, 403, 'delete');
  assert.equal((await p.share(ann, ws)).status, 403, 'share');
  assert.equal((await edit()).status, 403, 'edit');
  assert.ok(await stored(projectId));

  // Erased: the roster rows go, the key row stays and still names the person.
  await q('DELETE FROM workspace_members WHERE user_id = $1', [lee.userId]);
  assert.equal((await edit()).status, 200, 'edit once the person has no active membership');
  assert.equal((await p.archive(ann, ws)).status, 200, 'archive');
});

test('a key id that resolves to nobody: a solo owner keeps their legacy project; in a team with several active members it is ambiguous and is NOT left', async () => {
  const { ann, ws } = await makeTeam('r6pp14');
  const orphanId = await createProject(ann, ws, `Orphan key ${uuidv4().slice(0, 6)}`, 'private');
  await q('UPDATE context_projects SET owner_user_id = $2 WHERE project_id = $1', [orphanId, `key-nobody-${uuidv4()}`]);
  // Nobody on record as having written to it (round 7 would otherwise resolve the
  // stamp to its one writer): the stamp stays ambiguous.
  await q('DELETE FROM context_events WHERE project_id = $1', [orphanId]);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1', [orphanId]);
  // Privacy wins when we cannot tell whose it was: the key row may have been deleted.
  assert.equal((await powers(orphanId, null).archive(ann, ws)).status, 403);
  assert.ok(await stored(orphanId));

  const solo = await makePerson('r6pp14s');
  const mine = await createProject(solo, null, `Own old key ${uuidv4().slice(0, 6)}`, null);
  await q('UPDATE context_projects SET owner_user_id = $2, visibility = $3 WHERE project_id = $1', [mine, await keyFor(solo, solo.orgId), 'private']);
  assert.equal((await powers(mine, null).archive(solo, null)).status, 200, 'the owner\'s own legacy key stamp is not somebody else\'s');
  assert.equal((await powers(mine, null).remove(solo, null)).status, 200);
});

test('a key id whose api_keys row was DELETED, stamped on an active member\'s private project, does not open it to the owner', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp16');
  const T = tag();
  const projectId = await createProject(lee, ws, `Deleted key ${T}`, 'private');
  const keyId = await keyFor(lee, ws);
  await q('UPDATE context_projects SET owner_user_id = $2 WHERE project_id = $1', [projectId, keyId]);
  await q('DELETE FROM api_keys WHERE key_id = $1', [keyId]);
  const p = powers(projectId, null);

  const edit = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ current_status: `ANN${T}` });
  assert.equal(edit.status, 403, `PATCH: ${JSON.stringify(edit.body)}`);
  assert.equal((await p.rename(ann, ws, `Ann ${T}`)).status, 403, 'rename');
  assert.equal((await p.share(ann, ws)).status, 403, 'share');
  assert.equal((await p.archive(ann, ws)).status, 403, 'archive');
  assert.equal((await p.remove(ann, ws)).status, 403, 'DELETE');
  assert.ok(await stored(projectId), 'untouched');

  // Once only ONE person remains in the workspace, nobody else can be meant.
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id <> $2', [ws, ann.userId]);
  assert.equal((await p.archive(ann, ws)).status, 200, 'a workspace with one active member: the stamp cannot be anyone else\'s');
});

test('a decision stamped with a DELETED key id is not the owner\'s to drop while the workspace has several members', async () => {
  const { ann, lee, ws } = await makeTeam('r6pp17');
  const T = tag();
  const projectId = await createProject(lee, ws, `Deleted key entries ${T}`, 'shared');
  assert.equal((await as('post', '/api/v1/context/events', lee, ws).send({ event_type: 'decision_made', project_id: projectId, summary: `DELKEY${T} keep` })).status, 202);
  const project = await store.getProject(ws, projectId);
  project.context.recent_decisions = project.context.recent_decisions.map((d) => ({ ...d, contributed_by: `key-gone-${uuidv4()}` }));
  await store.saveProject(project, null);
  const cleared = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ recent_decisions: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const exported = await as('get', '/api/v1/context/export?format=json', ann, ws);
  assert.ok(JSON.stringify((exported.body.projects || []).find((x) => x.project_id === projectId)?.context || {}).includes(`DELKEY${T}`), 'the entry stays');
});

test('a decision stamped with an active member\'s key id is not the owner\'s to drop; one stamped with a departed member\'s is', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r6pp15');
  const T = tag();
  const projectId = await createProject(lee, ws, `Entries ${T}`, 'shared');
  for (const summary of [`KEYACTIVE${T} keep`, `KEYGONE${T} keep`]) {
    assert.equal((await as('post', '/api/v1/context/events', mia, ws).send({ event_type: 'decision_made', project_id: projectId, summary })).status, 202);
  }
  const leeKey = await keyFor(lee, ws);
  const miaKey = await keyFor(mia, ws);
  const project = await store.getProject(ws, projectId);
  project.context.recent_decisions = project.context.recent_decisions.map((d) => ({
    ...d, contributed_by: String(d.summary).startsWith('KEYACTIVE') ? leeKey : miaKey,
  }));
  await store.saveProject(project, null);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [ws, mia.userId]);

  const cleared = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ recent_decisions: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const exported = await as('get', '/api/v1/context/export?format=json', ann, ws);
  const text = JSON.stringify((exported.body.projects || []).find((x) => x.project_id === projectId)?.context || {});
  assert.ok(text.includes(`KEYACTIVE${T}`), 'the active member\'s entry stays');
  assert.ok(!text.includes(`KEYGONE${T}`), 'the departed member\'s entry goes');
});

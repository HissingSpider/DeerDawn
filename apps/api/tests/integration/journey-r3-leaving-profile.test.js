/**
 * JOURNEY SCAN ROUND 3, D-2: LEAVING A TEAM TAKES YOUR PROFILE HOME.
 *
 * A person accepts an invite (the team becomes their active workspace), writes
 * their "about you" profile and recurring instructions there, and later leaves
 * or is removed. Their personal projects travelled home; the profile did not:
 * afterwards their profile read empty, the team answered 403, the row stayed
 * stored under the team where only its author could ever read it, their export
 * did not hold it and their next brief had lost the instruction.
 *
 * The owner's decision: it moves home, the way personal projects do, merged
 * into the profile already there without overwriting anything
 * (workspaceService.carryPersonalProfile / mergePersonalProfiles).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-leaving-profile.test.js
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
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const encryption = require('../../src/services/encryptionService');

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

async function join(owner, joiner, role = 'member', teamKey = owner.orgId) {
  const invite = await workspace.createInvite(teamKey, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const profileRow = async (ownerKey, personId) => (await q(
  'SELECT global FROM context_globals WHERE owner_key = $1 AND person_id = $2',
  [ownerKey, personId],
)).rows[0]?.global || null;

const tag = () => uuidv4().slice(0, 8).toUpperCase();

// ── The journey, as the walker drove it ──────────────────────────────────────

test('a member who leaves takes their profile home: read, export and next brief all carry it', async () => {
  const T = tag();
  const ann = await makePerson('r3p-ann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-lee');
  await join(ann, lee);

  // No workspace header: what the dashboard and a hosted tool send once the
  // invite is accepted. It lands in the team.
  const wrote = await as('patch', '/api/v1/context/global', lee).send({
    user_profile: `I am Lee LEEPROFILE${T}`,
    recurring_instructions: [`Always LEEINSTRUCTION${T}`],
    working_style: `LEESTYLE${T}`,
  });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.ok((await profileRow(ann.orgId, lee.userId))?.user_profile?.includes(`LEEPROFILE${T}`), 'precondition: the profile is stored under the team');

  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.left, true);
  assert.equal(left.body.profile_moved, true, `the reply says the profile moved: ${JSON.stringify(left.body)}`);
  assert.equal(left.body.profile_moved_to, lee.orgId);
  assert.equal(left.body.profile_merged, false);
  assert.equal(left.body.profile_not_moved, undefined);

  // Not stored under the team any more; stored at home.
  assert.equal(await profileRow(ann.orgId, lee.userId), null, 'nothing of Lee\'s profile is left under the team');
  const home = await profileRow(lee.orgId, lee.userId);
  assert.equal(home.user_profile, `I am Lee LEEPROFILE${T}`);
  assert.deepEqual(home.recurring_instructions, [`Always LEEINSTRUCTION${T}`]);
  assert.equal(home.working_style, `LEESTYLE${T}`);

  // What the person reads, with no header, after leaving.
  const read = await as('get', '/api/v1/context/global', lee);
  assert.equal(read.status, 200);
  assert.equal(read.body.global.user_profile, `I am Lee LEEPROFILE${T}`);
  assert.deepEqual(read.body.global.recurring_instructions, [`Always LEEINSTRUCTION${T}`]);

  const exported = await as('get', '/api/v1/context/export?format=json', lee);
  assert.equal(exported.status, 200);
  const text = JSON.stringify(exported.body);
  assert.ok(text.includes(`LEEPROFILE${T}`) && text.includes(`LEEINSTRUCTION${T}`), 'their own export holds the profile');

  // The next brief, in their personal workspace, carries the instruction.
  const made = await as('post', '/api/v1/context/projects', lee, lee.orgId).send({ project_name: `Lee home ${T}`, current_task: 'x' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const brief = await as('get', `/api/v1/context/projects/${made.body.project.project_id}/inject?tool=claude_code`, lee);
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  assert.ok(JSON.stringify(brief.body).includes(`LEEINSTRUCTION${T}`), 'the next brief carries the recurring instruction');
});

test('a member removed by an owner takes their profile home too, and the audit row records it', async () => {
  const T = tag();
  const tess = await makePerson('r3p-tess', { plan: 'developer_pro' });
  const mel = await makePerson('r3p-mel');
  await join(tess, mel);
  const wrote = await as('patch', '/api/v1/context/global', mel, tess.orgId).send({ user_profile: `MELPROFILE${T}` });
  assert.equal(wrote.status, 200);

  const removed = await as('delete', `/api/v1/teams/members/${mel.userId}`, tess, tess.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.left, false);
  assert.equal(removed.body.profile_moved, true);
  assert.equal(removed.body.profile_moved_to, mel.orgId);
  assert.equal(await profileRow(tess.orgId, mel.userId), null);
  assert.equal((await profileRow(mel.orgId, mel.userId)).user_profile, `MELPROFILE${T}`);
  const read = await as('get', '/api/v1/context/global', mel);
  assert.equal(read.body.global.user_profile, `MELPROFILE${T}`);

  const audit = (await q(
    'SELECT metadata FROM context_audit_logs WHERE owner_key = $1 AND action = \'member_removed\' ORDER BY created_at DESC LIMIT 1',
    [tess.orgId],
  )).rows[0];
  assert.ok(audit, 'the team keeps its record of the removal');
  assert.equal(audit.metadata.profile_moved, true, JSON.stringify(audit.metadata));
});

// ── The merge rule, one example per kind of field ────────────────────────────

test('with a profile at home the two are merged field by field and nothing is overwritten', async () => {
  const ann = await makePerson('r3p-mann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-mlee');
  // At home first.
  const homeWrite = await as('patch', '/api/v1/context/global', lee, lee.orgId).send({
    user_profile: 'Founder of Acme.',
    working_style: 'Terse',
    communication_preferences: '',
    preferences: ['Use pnpm', 'Write tests'],
    recurring_instructions: ['Run the linter'],
    goals: [],
  });
  assert.equal(homeWrite.status, 200);
  await join(ann, lee);
  const teamWrite = await as('patch', '/api/v1/context/global', lee, ann.orgId).send({
    user_profile: 'Backend lead on payments.',
    working_style: 'Terse',
    communication_preferences: 'Bullet points',
    preferences: ['Write tests', 'No emojis'],
    recurring_instructions: [],
    goals: ['Ship billing v2'],
  });
  assert.equal(teamWrite.status, 200);

  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.profile_moved, true);
  assert.equal(left.body.profile_merged, true);

  const merged = (await as('get', '/api/v1/context/global', lee)).body.global;
  // Text, different on both sides: home text, then the team text after it.
  assert.equal(merged.user_profile, 'Founder of Acme.\n\nBackend lead on payments.');
  // Text, same on both sides: kept once.
  assert.equal(merged.working_style, 'Terse');
  // Text only the team has: kept.
  assert.equal(merged.communication_preferences, 'Bullet points');
  // List on both sides: union, home first, no duplicates.
  assert.deepEqual(merged.preferences, ['Use pnpm', 'Write tests', 'No emojis']);
  // List only home has: kept.
  assert.deepEqual(merged.recurring_instructions, ['Run the linter']);
  // List only the team has: kept.
  assert.deepEqual(merged.goals, ['Ship billing v2']);
  assert.equal(await profileRow(ann.orgId, lee.userId), null);
});

test('mergePersonalProfiles: the rule on its own, including a second homecoming', () => {
  const merge = workspace.mergePersonalProfiles;
  assert.deepEqual(
    merge(
      { user_profile: '', preferences: ['a', 'b'], working_style: ' Terse ', updated_at: '2026-09-01T00:00:00.000Z' },
      { user_profile: 'Backend lead', preferences: ['b', ' c', 'a'], working_style: 'Terse', updated_at: '2026-09-20T00:00:00.000Z' },
    ),
    { user_profile: 'Backend lead', preferences: ['a', 'b', ' c'], working_style: ' Terse ', updated_at: '2026-09-20T00:00:00.000Z' },
  );
  // The team text already a whole paragraph of the home text is not doubled.
  assert.equal(merge({ user_profile: 'A.\n\nB.' }, { user_profile: 'B.' }).user_profile, 'A.\n\nB.');
  // ...but a word the team text shares with the home text is not a reason to drop it.
  assert.equal(merge({ working_style: 'I work fast' }, { working_style: 'fast' }).working_style, 'I work fast\n\nfast');
  // Nothing on either side stays nothing; a field only home has is kept.
  assert.deepEqual(merge({ goals: ['g'] }, {}), { goals: ['g'] });
  assert.deepEqual(merge({}, { values: ['v'] }), { values: ['v'] });
});

// ── Every way out ────────────────────────────────────────────────────────────

test('a founder re-homed out of the team they handed over takes their profile to the new workspace', async () => {
  const T = tag();
  const tess = await makePerson('r3p-founder', { plan: 'developer_pro' });
  const mel = await makePerson('r3p-heir');
  await join(tess, mel);
  await as('patch', '/api/v1/context/global', tess, tess.orgId).send({ user_profile: `TESSPROFILE${T}` }).expect(200);
  await as('patch', `/api/v1/teams/members/${mel.userId}`, tess, tess.orgId).send({ role: 'owner' }).expect(200);

  const left = await as('delete', `/api/v1/teams/members/${tess.userId}`, tess, tess.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.ok(left.body.rehomed_to, 'the founder is given a workspace of their own');
  assert.equal(left.body.profile_moved, true);
  assert.equal(left.body.profile_moved_to, left.body.rehomed_to);
  assert.equal(await profileRow(tess.orgId, tess.userId), null);
  assert.equal((await profileRow(left.body.rehomed_to, tess.userId)).user_profile, `TESSPROFILE${T}`);
  // Their next session (a fresh sign-in points at the new workspace) reads it.
  tess.jwt = generateToken({ user_id: tess.userId, org_id: left.body.rehomed_to, role: 'owner', email: tess.email });
  assert.equal((await as('get', '/api/v1/context/global', tess)).body.global.user_profile, `TESSPROFILE${T}`);
});

test('somebody barred from their own workspace keeps the profile where it is, and the reply says why', async () => {
  const ann = await makePerson('r3p-bann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-blee');
  await join(ann, lee);
  await as('patch', '/api/v1/context/global', lee, ann.orgId).send({ user_profile: 'stays' }).expect(200);
  // Their own workspace has removed them (the legacy state the carry refuses to deliver into).
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [lee.orgId, lee.userId]);

  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.profile_moved, false);
  assert.equal(removed.body.profile_moved_to, null);
  assert.equal(removed.body.profile_not_moved, 'no_workspace_of_their_own');
  assert.equal((await profileRow(ann.orgId, lee.userId)).user_profile, 'stays');
});

test('a profile with nothing written in it is left alone and nothing is claimed', async () => {
  const ann = await makePerson('r3p-eann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-elee');
  await join(ann, lee);
  await q(
    'INSERT INTO context_globals (owner_key, person_id, global) VALUES ($1, $2, $3)',
    [ann.orgId, lee.userId, JSON.stringify({ user_profile: '', preferences: [], updated_at: new Date().toISOString() })],
  );
  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200);
  assert.equal(left.body.profile_moved, false);
  assert.equal(left.body.profile_not_moved, undefined);
  assert.equal(await profileRow(lee.orgId, lee.userId), null, 'no empty row is written at home');
});

test('a resident re-homed when the workspace they point at closes takes their profile with them', async () => {
  const T = tag();
  const F = await makePerson('r3p-close-f', { plan: 'developer_pro' });
  const L = await makePerson('r3p-close-l');
  await join(F, L);
  await as('patch', '/api/v1/context/global', L, F.orgId).send({ recurring_instructions: [`LRESIDENT${T}`] }).expect(200);
  // The legacy population: L's users.org_id IS the team, removed without being re-homed.
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [F.orgId, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [F.orgId, L.userId]);

  const res = await as('delete', '/api/v1/orgs', F).send({ password: 'password123' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const lRow = (await q('SELECT org_id FROM users WHERE user_id = $1', [L.userId])).rows[0];
  assert.ok(lRow && lRow.org_id !== F.orgId, 're-homed');
  assert.deepEqual((await profileRow(lRow.org_id, L.userId))?.recurring_instructions, [`LRESIDENT${T}`]);
});

// ── Nothing else moves ───────────────────────────────────────────────────────

test('nothing of the team or of anybody else moves; a note private to the leaver stays exactly as it was', async () => {
  const T = tag();
  const ann = await makePerson('r3p-nann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-nlee');
  const kim = await makePerson('r3p-nkim');
  await join(ann, lee);
  await join(ann, kim);
  await as('patch', '/api/v1/context/global', ann, ann.orgId).send({ user_profile: `ANNPROFILE${T}` }).expect(200);
  await as('patch', '/api/v1/context/global', kim, ann.orgId).send({ user_profile: `KIMPROFILE${T}` }).expect(200);
  await as('patch', '/api/v1/context/global', lee, ann.orgId).send({ user_profile: `LEEPROFILE${T}` }).expect(200);
  const now = new Date().toISOString();
  const note = await store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: ann.orgId, project_id: null, node_type: 'knowledge',
    canonical_key: `knowledge:lee-note-${T.toLowerCase()}`, title: `Lee note ${T}`, summary: `LEENOTE${T}`,
    metadata: { private_to: lee.userId }, confidence: 0.9, source_tool: 'claude_code',
    created_at: now, updated_at: now, last_seen_at: now,
  });
  const before = (await q('SELECT owner_key, metadata, summary FROM context_graph_nodes WHERE node_id = $1', [note.node_id])).rows[0];

  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));

  assert.equal((await profileRow(ann.orgId, ann.userId)).user_profile, `ANNPROFILE${T}`);
  assert.equal((await profileRow(ann.orgId, kim.userId)).user_profile, `KIMPROFILE${T}`);
  assert.equal(await profileRow(lee.orgId, ann.userId), null);
  assert.equal(await profileRow(lee.orgId, kim.userId), null);
  const after = (await q('SELECT owner_key, metadata, summary FROM context_graph_nodes WHERE node_id = $1', [note.node_id])).rows[0];
  assert.deepEqual(after, before, 'the private note is out of scope and untouched');
  // Only Lee's one row left the team.
  const rows = (await q('SELECT person_id FROM context_globals WHERE owner_key = $1 ORDER BY person_id', [ann.orgId])).rows.map((r) => r.person_id);
  assert.deepEqual(rows, [ann.userId, kim.userId].sort());
});

// ── Sealed at rest ───────────────────────────────────────────────────────────

test('a sealed profile row is re-sealed under the destination\'s key, alone or merged', async () => {
  assert.ok(encryption.shouldEncrypt(), 'this test runs with ENCRYPTION_MASTER_KEY set');
  const T = tag();
  const ann = await makePerson('r3p-sann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-slee');
  const kim = await makePerson('r3p-skim');
  await join(ann, lee);
  await join(ann, kim);
  const seal = (key, value) => encryption.encryptContextObject(key, value);
  const put = async (key, person, value) => q(
    `INSERT INTO context_globals (owner_key, person_id, global) VALUES ($1, $2, $3)
     ON CONFLICT (owner_key, person_id) DO UPDATE SET global = EXCLUDED.global`,
    [key, person, JSON.stringify(value)],
  );

  // Lee: sealed in the team, nothing at home -> sealed under Lee's home key.
  await put(ann.orgId, lee.userId, await seal(ann.orgId, { user_profile: `SEALED${T}`, goals: ['g1'] }));
  const leeLeft = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(leeLeft.status, 200, JSON.stringify(leeLeft.body));
  assert.equal(leeLeft.body.profile_moved, true);
  const leeStored = await profileRow(lee.orgId, lee.userId);
  assert.ok(leeStored._enc, 'stays sealed at rest');
  assert.equal((await encryption.decryptContextObject(lee.orgId, leeStored)).user_profile, `SEALED${T}`);
  await assert.rejects(encryption.decryptContextObject(ann.orgId, leeStored), 'not openable with the team\'s key');

  // Kim: sealed in the team, sealed at home -> merged, sealed under Kim's home key.
  await put(kim.orgId, kim.userId, await seal(kim.orgId, { user_profile: 'Home Kim.', goals: ['home goal'] }));
  await put(ann.orgId, kim.userId, await seal(ann.orgId, { user_profile: 'Team Kim.', goals: ['team goal'] }));
  const kimOut = await as('delete', `/api/v1/teams/members/${kim.userId}`, ann, ann.orgId);
  assert.equal(kimOut.status, 200, JSON.stringify(kimOut.body));
  assert.equal(kimOut.body.profile_merged, true);
  const kimStored = await profileRow(kim.orgId, kim.userId);
  assert.ok(kimStored._enc);
  const kimOpen = await encryption.decryptContextObject(kim.orgId, kimStored);
  assert.equal(kimOpen.user_profile, 'Home Kim.\n\nTeam Kim.');
  assert.deepEqual(kimOpen.goals, ['home goal', 'team goal']);
  assert.equal(await profileRow(ann.orgId, kim.userId), null);
});

test('a profile row that cannot be opened stays where it is and the removal still happens', async () => {
  const ann = await makePerson('r3p-uann', { plan: 'developer_pro' });
  const lee = await makePerson('r3p-ulee');
  await join(ann, lee);
  await q(
    'INSERT INTO context_globals (owner_key, person_id, global) VALUES ($1, $2, $3)',
    [ann.orgId, lee.userId, JSON.stringify({ _enc: 'v1:AAAA:BBBB:CCCC' })],
  );
  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.profile_moved, false);
  assert.equal(removed.body.profile_not_moved, 'unreadable');
  assert.ok((await profileRow(ann.orgId, lee.userId))._enc, 'left in place');
  const roster = (await q('SELECT removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [ann.orgId, lee.userId])).rows[0];
  assert.ok(roster.removed_at, 'the removal itself went through');
});

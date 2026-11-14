'use strict';

/**
 * "DELETE MY ACCOUNT" ERASES A PERSON'S PERSONAL PROJECTS IN OTHER PEOPLE'S
 * WORKSPACES, SO THE "LAST COPY" IT EMAILS HAS TO CARRY THEM.
 *
 * A member of a team who keeps a project there as `personal` is its only
 * reader (CLAUDE.md, "Multi-user workspaces"): not even a workspace owner reads
 * it. Deleting the account erases it with them (dataErasureService
 * erasePersonalProjectsElsewhere). The deletion email says the attachment holds
 * "every project including archived ones" and that "this is the last copy we
 * hold", and the attachment was taken of the person's OWN workspace only, so
 * those projects were destroyed with no copy anywhere (journey scan round 2,
 * R2-2: the walker's s7b-member-personal).
 *
 * The other direction matters as much. The export is taken against the org being
 * destroyed ON PURPOSE: exporting the person's active workspace once mailed a
 * departing teammate the whole team's brain. So the fix must not reopen that:
 * the attachment carries what the purge takes and nothing that stays with the
 * team — a colleague's personal project, the team's private and shared work
 * (including shared work the leaver contributed to), a section a share
 * withholds, a node private to somebody else, the team's workspace entities.
 *
 * Real database, real services and a real purge. Only auth, Stripe, Clerk and
 * the email transport are replaced.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/account-delete-export-elsewhere.test.js
 */

// Context is sealed at rest exactly when a master key is set, as it is in
// production. CI's API job sets none, so without this the undecryptable-project
// case below had nothing to corrupt and failed its precondition there, while
// passing on any machine that exported a key. Set before anything is required;
// node --test runs each file in its own process, so it reaches no other file.
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// Both destructured by orgs.js at load time, so replaced on the module objects
// BEFORE the router is required.
const auth = require('../../src/middleware/auth');
let actor = null;
auth.requireAuth = (req, _res, next) => { req.actor = { ...actor }; next(); };
auth.isClerkConfigured = () => false;
auth.deleteClerkUser = async () => ({ skipped: true });

const stripe = require('../../src/services/stripeService');
const cancelled = [];
// What the billing cancel answers; a test sets it to a failure and back.
let cancelResult = { ok: true, cancelled: false };
stripe.cancelSubscriptionForDeletion = async (orgId) => { cancelled.push(orgId); return cancelResult; };

const resend = require('../../src/services/email/resendClient');
const sent = [];
// What the email transport answers; a test sets it to a failure and back.
let sendResult = { ok: true };
resend.sendEmail = async (message) => { sent.push(message); return sendResult; };

// The bundle the route actually renders, kept so the renderer's own completeness
// check (every key printed or deliberately listed) can be run on it.
const exportMarkdown = require('../../src/services/contextExportMarkdown');
const renderMarkdown = exportMarkdown.renderContextExportMarkdown;
let renderedBundle = null;
exportMarkdown.renderContextExportMarkdown = (bundle) => { renderedBundle = bundle; return renderMarkdown(bundle); };

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const erasure = require('../../src/services/dataErasureService');

const app = express();
app.use(express.json());
app.use('/api/v1/orgs', require('../../src/routes/shared/orgs'));

// Capital letters only: graph node titles are re-cased on read, and an
// all-capitals word with no digit is the one form they keep verbatim.
const RUN = [...crypto.randomBytes(8)].map((byte) => String.fromCharCode(65 + (byte % 26))).join('');
const mark = (label) => `${label}${RUN}`;

const q = (sql, params) => db.query(sql, params, 'org-system').then((r) => r.rows);
const created = [];

// A person with their own workspace, the shape every signup has.
async function makePerson(label) {
  const orgId = `org-${crypto.randomUUID()}`;
  const userId = `user-${crypto.randomUUID()}`;
  const email = `${label.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomUUID().slice(0, 8)}@export-elsewhere.test`;
  const name = `${label} ${RUN}`;
  created.push(orgId);
  await q(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, $2, 'free', 'free', 'active', 'organization')`,
    [orgId, name]
  );
  await q(
    `INSERT INTO users (user_id, email, role, org_id, auth_provider)
     VALUES ($1, $2, 'owner', $3, 'local')`,
    [userId, email, orgId]
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  // The actor this person makes requests as, bound to `ownerKey` the way the
  // auth middleware binds a workspace they belong to.
  const as = (ownerKey = orgId) => ({
    type: 'user', id: userId, email, org_id: orgId, workspace_key: ownerKey, role: 'owner',
    scopes: ['context:read', 'context:write', 'context:admin'],
  });
  return { orgId, userId, email, name, as };
}

// A second workspace a person creates and nobody else is in (POST
// /teams/workspaces), which closes with their account.
async function makeSideWorkspace(person, label) {
  const orgId = `org-${crypto.randomUUID()}`;
  const name = `${label} ${RUN}`;
  created.push(orgId);
  await q(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, $2, 'free', 'free', 'active', 'organization')`,
    [orgId, name]
  );
  await workspace.addMember(orgId, person.userId, { role: 'owner' });
  return { orgId, name };
}

async function setVisibility(ownerKey, projectId, visibility) {
  const row = await store.getProject(ownerKey, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

// A project written through the service as `who`, then given `visibility`, the
// way the sharing panel sets it.
async function makeProject(who, ownerKey, name, visibility, context) {
  const project = await service.createProject(who.as(ownerKey), { project_name: name });
  if (visibility) await setVisibility(ownerKey, project.project_id, visibility);
  if (context) await service.updateProjectContext(who.as(ownerKey), project.project_id, context);
  return project.project_id;
}

async function addEntity(who, ownerKey, projectId, title) {
  await service.upsertWorkspaceEntities(who.as(ownerKey), {
    project_id: projectId,
    entities: [{ title, entity_type: 'component', summary: 'Renders the export bundle from the stored keys', project_id: projectId, scope: 'project' }],
  });
}

// A node with no project (`projectId` unset): the workspace's own, which every
// member reads unless it is marked private to somebody. private_to is
// server-only metadata, so it is seeded at the store, the way the ownership
// backfill (and a carried project's kept nodes) write it.
async function seedWorkspaceNode(ownerKey, title, metadata = {}, { summary = 'a workspace fact', projectId = null } = {}) {
  const now = new Date().toISOString();
  return store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ownerKey,
    project_id: projectId,
    node_type: 'knowledge',
    canonical_key: `knowledge:${title.toLowerCase()}`,
    title,
    summary,
    metadata: { entity_type: 'knowledge', scope: projectId ? 'project' : 'workspace', importance: 'high', status: 'active', ...metadata },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
}

async function seedEdge(ownerKey, from, to, summary) {
  const now = new Date().toISOString();
  return store.upsertGraphEdge({
    edge_id: `graph_edge_${crypto.randomUUID()}`,
    owner_key: ownerKey,
    project_id: null,
    edge_type: 'related_to',
    from_node_id: from.node_id,
    to_node_id: to.node_id,
    summary,
    metadata: {},
    confidence: 0.8,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
}

// A sighting of `node` in `projectId`: the evidence row a session leaves.
async function seedEvidence(ownerKey, node, projectId, excerpt) {
  return store.addGraphEvidence({
    evidence_id: `graph_evidence_${crypto.randomUUID()}`,
    owner_key: ownerKey,
    project_id: projectId,
    session_id: `session_${crypto.randomUUID()}`,
    node_id: node.node_id,
    edge_id: null,
    tool: 'claude_code',
    excerpt,
    metadata: {},
    confidence: 0.8,
    created_at: new Date().toISOString(),
  });
}

const profileExists = async (ownerKey, personId) => (await q('SELECT 1 FROM context_globals WHERE owner_key = $1 AND person_id = $2', [ownerKey, personId])).length === 1;
const nodeExists = async (nodeId) => (await q('SELECT 1 FROM context_graph_nodes WHERE node_id = $1', [nodeId])).length === 1;

// Break a project's sealed context the way a lost or rotated key does: the row
// is still there, and it can no longer be opened.
async function corrupt(ownerKey, projectId) {
  const [row] = await q('SELECT context FROM context_projects WHERE owner_key = $1 AND project_id = $2', [ownerKey, projectId]);
  assert.ok(row?.context?._enc, 'precondition: the context is encrypted at rest (the key set at the top of this file took effect)');
  const sealed = row.context._enc;
  const tampered = `${sealed.slice(0, -6)}${sealed.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'}`;
  await q(
    'UPDATE context_projects SET context = $3::jsonb WHERE owner_key = $1 AND project_id = $2',
    [ownerKey, projectId, JSON.stringify({ ...row.context, _enc: tampered })]
  );
}

const projectExists = async (projectId) => (await q('SELECT 1 FROM context_projects WHERE project_id = $1', [projectId])).length === 1;

// DELETE /api/v1/orgs with "email me an export", signed in with `boundTo` as
// the active workspace (the default state for anybody who has accepted an
// invite). Returns the reply, the email and its attachment as text.
async function deleteAccount(person, boundTo = person.orgId, { emailExport = true } = {}) {
  sent.length = 0;
  cancelled.length = 0;
  actor = person.as(boundTo);
  const res = await request(app).delete('/api/v1/orgs/').send({ confirm_email: person.email, email_export: emailExport });
  const mail = sent.find((message) => /context export/i.test(message?.subject || ''));
  const attachment = mail ? Buffer.from(mail.attachments[0].content, 'base64').toString('utf-8') : '';
  return { res, mail, attachment, html: mail?.html || '' };
}

// The block of the attachment under the `## ` heading that begins with
// `heading`, up to the next `## ` heading; null when there is no such heading.
function section(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

after(async () => {
  for (const orgId of created) {
    await erasure.purgeOwnerData(orgId, { workspaceOnly: true }).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
  }
  await closeRedisConnections?.().catch(() => {});
  await db.pool.end().catch(() => {});
});

// ── the walker's story ──────────────────────────────────────────────────────

test('a member\'s personal project in a team is in the attachment, under the team\'s name, and is then erased', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Acme team');
  const member = await makePerson('Mina');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const M = {
    own: mark('OWNWORKSPACETASK'),
    task: mark('MEMBERTHETA'),
    decision: mark('MEMBERDECISION'),
    entity: mark('MEMBERENTITY'),
    skill: mark('MEMBERSKILL'),
  };
  await makeProject(member, member.orgId, `My own side project ${RUN}`, null, { current_task: `Own work ${M.own}` });
  const personal = await makeProject(member, owner.orgId, `Member notes in team ${RUN}`, 'personal', {
    current_task: `My private notes ${M.task}`,
    recent_decisions: [{ summary: `Decided ${M.decision}`, decided_at: '2026-09-20T00:00:00.000Z' }],
  });
  await addEntity(member, owner.orgId, personal, `Member widget ${M.entity}`);
  // A skill filed in the project goes with it: workspace_skills.project_id is
  // ON DELETE CASCADE.
  await service.upsertSkill(member.as(owner.orgId), { project_id: personal, name: `Member skill ${RUN}`, markdown_content: `Run ${M.skill} first.` });

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);

  // The purge is unchanged: the project is erased.
  assert.equal(await projectExists(personal), false, 'the personal project in the team is erased with the account');

  assert.ok(attachment.includes(M.own), 'the member\'s own workspace is exported, as before');
  const block = section(attachment, `Personal projects in ${owner.name} (1)`);
  assert.ok(block, `the attachment has a block headed with the team's name; it had:\n${attachment.split('\n').filter((l) => l.startsWith('## ')).join('\n')}`);
  for (const [label, marker] of Object.entries(M).filter(([key]) => key !== 'own' && key !== 'skill')) {
    assert.ok(block.includes(marker), `the personal project's ${label} is in the team's block`);
  }
  assert.ok(attachment.includes(M.skill), 'the skill filed in it too');
  assert.deepEqual(exportMarkdown.unaccountedKeys(renderedBundle), [], 'every key of the carried block is rendered or deliberately listed as not rendered');
  assert.match(html, new RegExp(`every project in your own workspace including archived ones, their task boards, notes and knowledge graph, and your skills\\. It also carries the personal project you kept in ${owner.name}, under that workspace's name; that workspace's shared and private projects stay with it and are not attached\\.`),
    'the email says what else is attached, where it lived, and what of that workspace is not');
  assert.match(html, /a full Markdown export/, 'nothing the purge takes is missing, so the copy is still full');
});

// ── what stays with the team does not travel ────────────────────────────────

test('nothing that stays with the team is in the departing member\'s attachment', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Beacon team');
  const member = await makePerson('Mo');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const mine = mark('MOPERSONAL');
  const personal = await makeProject(member, owner.orgId, `Mo personal ${RUN}`, 'personal', { current_task: `Mine ${mine}` });

  const NOT = {
    colleaguePersonal: mark('COLLEAGUEPERSONAL'),
    teamPrivate: mark('TEAMPRIVATE'),
    membersOwnPrivate: mark('MOPRIVATEORGWORK'),
    sharedTask: mark('TEAMSHAREDTASK'),
    sharedContribution: mark('MOSHAREDCONTRIBUTION'),
    withheld: mark('WITHHELDGOAL'),
    privateToOwner: mark('OWNERPRIVATENOTE'),
    teamEntity: mark('TEAMENTITY'),
  };
  const colleaguePersonal = await makeProject(owner, owner.orgId, `Owner diary ${RUN}`, 'personal', { current_task: `Diary ${NOT.colleaguePersonal}` });
  const teamPrivate = await makeProject(owner, owner.orgId, `Owner private ${RUN}`, 'private', { current_task: `Org work ${NOT.teamPrivate}` });
  // 'private' is the ORG's, even when the leaver wrote it: an owner reads it,
  // and it stays when its author goes.
  const membersPrivate = await makeProject(member, owner.orgId, `Mo private ${RUN}`, 'private', { current_task: `Org work by Mo ${NOT.membersOwnPrivate}` });
  // `goals` is outside the default share: the project is shared, the goals are
  // not. An array, because a bare string is coerced to [] and would pass for the
  // wrong reason.
  const shared = await makeProject(owner, owner.orgId, `Team shared ${RUN}`, 'shared', { current_task: `Team work ${NOT.sharedTask}`, goals: [`Aim ${NOT.withheld}`] });
  // Shared work the leaver contributed to is the team's, and stays with it.
  await service.updateProjectContext(member.as(owner.orgId), shared, {
    recent_decisions: [{ summary: `Mo decided ${NOT.sharedContribution}`, decided_at: '2026-09-21T00:00:00.000Z' }],
  });
  await seedWorkspaceNode(owner.orgId, `Owner only ${NOT.privateToOwner}`, { private_to: owner.userId });
  await seedWorkspaceNode(owner.orgId, `Team fact ${NOT.teamEntity}`);

  // Preconditions: the member can READ most of these (so their absence is the
  // export's doing, not the reader's), and the contribution really landed. This
  // is also the Settings > Data download while bound to the team (GET
  // /context/export exports the bound workspace), which is unchanged: it carries
  // the member's own personal project there, and everything else they read.
  const readable = JSON.stringify(await service.exportContext(member.as(owner.orgId)));
  for (const marker of [mine, NOT.sharedTask, NOT.sharedContribution, NOT.teamEntity]) {
    assert.ok(readable.includes(marker), `precondition: the member reads ${marker} in the team`);
  }

  const { res, attachment } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);
  assert.ok(attachment.includes(mine), 'the member\'s own personal project in the team IS carried (so the absences below are not an empty export)');

  const leaked = Object.entries(NOT).filter(([, marker]) => attachment.includes(marker)).map(([label]) => label);
  assert.deepEqual(leaked, [], 'nothing that stays with the team is in the attachment');

  // And all of it stayed.
  assert.equal(await projectExists(personal), false, 'the personal project was erased');
  for (const [label, projectId] of Object.entries({ colleaguePersonal, teamPrivate, membersPrivate, shared })) {
    assert.equal(await projectExists(projectId), true, `${label} stays with the team`);
  }
});

// ── more than one team ──────────────────────────────────────────────────────

test('a member with personal projects in two teams gets both, each under its own workspace', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const first = await makePerson('Comet team');
  const second = await makePerson('Delta team');
  const member = await makePerson('Mae');
  await workspace.addMember(first.orgId, member.userId, { role: 'member' });
  await workspace.addMember(second.orgId, member.userId, { role: 'member' });

  const inFirst = [mark('MAEFIRSTONE'), mark('MAEFIRSTTWO')];
  const inSecond = mark('MAESECOND');
  const ids = [
    await makeProject(member, first.orgId, `Mae first one ${RUN}`, 'personal', { current_task: `Work ${inFirst[0]}` }),
    await makeProject(member, first.orgId, `Mae first two ${RUN}`, 'personal', { current_task: `Work ${inFirst[1]}` }),
    await makeProject(member, second.orgId, `Mae second ${RUN}`, 'personal', { current_task: `Work ${inSecond}` }),
  ];

  const { res, attachment, html } = await deleteAccount(member, second.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);

  const firstBlock = section(attachment, `Personal projects in ${first.name} (2)`);
  const secondBlock = section(attachment, `Personal projects in ${second.name} (1)`);
  assert.ok(firstBlock && secondBlock, 'one block per workspace, each headed with its name and count');
  assert.ok(inFirst.every((marker) => firstBlock.includes(marker)), 'both projects of the first team sit under it');
  assert.ok(!firstBlock.includes(inSecond), 'and nothing from the second');
  assert.ok(secondBlock.includes(inSecond), 'the second team\'s project sits under the second team');
  assert.ok(!inFirst.some((marker) => secondBlock.includes(marker)), 'and nothing from the first');
  assert.ok(html.includes(first.name) && html.includes(second.name), 'the email names both workspaces');
  for (const projectId of ids) assert.equal(await projectExists(projectId), false, 'each was erased');
});

test('an archived personal project in a team is in the attachment, marked archived', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Ember team');
  const member = await makePerson('Max');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const marker = mark('MAXARCHIVED');
  const projectId = await makeProject(member, owner.orgId, `Max old notes ${RUN}`, 'personal', { current_task: `Old work ${marker}` });
  await service.archiveProject(member.as(owner.orgId), projectId);

  const { res, attachment } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const block = section(attachment, `Personal projects in ${owner.name} (1)`);
  assert.ok(block, 'the team has a block');
  assert.ok(block.includes(marker), 'the archived project\'s context is carried');
  assert.match(block, new RegExp(`### Max old notes ${RUN} \\(archived\\)`), 'and its heading says it is archived');
  assert.equal(await projectExists(projectId), false, 'it was erased, archived or not');
});

// ── the export and the purge select the same set ────────────────────────────

test('listPersonalProjectsElsewhere names exactly the projects the purge then erases', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Fjord team');
  const member = await makePerson('Mira');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const personal = await makeProject(member, owner.orgId, `Mira personal ${RUN}`, 'personal', { current_task: 'mine' });
  const archived = await makeProject(member, owner.orgId, `Mira archived ${RUN}`, 'personal', { current_task: 'old' });
  await service.archiveProject(member.as(owner.orgId), archived);
  await makeProject(member, owner.orgId, `Mira shared ${RUN}`, 'shared', { current_task: 'the team\'s' });
  await makeProject(member, owner.orgId, `Mira private ${RUN}`, 'private', { current_task: 'the org\'s' });
  await makeProject(owner, owner.orgId, `Fjord owner personal ${RUN}`, 'personal', { current_task: 'not hers' });
  await makeProject(member, member.orgId, `Mira at home ${RUN}`, null, { current_task: 'the home sweep takes this' });
  // A row stamped with one of her API KEY ids rather than her user id, as rows
  // written before attribution named people were: the purge matches those too.
  const keyId = `key-${crypto.randomUUID()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, 'dd_test', $2, 'elsewhere', $3, $4, 'production', now() + interval '1 year', $5)`,
    [keyId, `hash-${crypto.randomUUID()}`, member.userId, owner.orgId, ['context:read']]
  );
  const keyStamped = `proj-${crypto.randomUUID()}`;
  await q(
    `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name)
     VALUES ($1, $2, $3, 'personal', $4)`,
    [keyStamped, owner.orgId, keyId, `Mira key-stamped ${RUN}`]
  );

  const listed = await erasure.listPersonalProjectsElsewhere(member.orgId, { userIds: [member.userId] });
  const listedIds = listed.map((row) => row.project_id).sort();
  assert.deepEqual(listedIds, [personal, archived, keyStamped].sort(), 'her personal projects outside her own workspace, by every id she is stamped under');
  assert.ok(listed.every((row) => row.owner_key === owner.orgId), 'each with the workspace it lives in');

  const before = new Set((await q('SELECT project_id FROM context_projects WHERE owner_key = $1', [owner.orgId])).map((row) => row.project_id));
  const deleted = await erasure.purgeOwnerData(member.orgId);
  const afterIds = new Set((await q('SELECT project_id FROM context_projects WHERE owner_key = $1', [owner.orgId])).map((row) => row.project_id));
  const erased = [...before].filter((id) => !afterIds.has(id)).sort();
  assert.deepEqual(erased, listedIds, 'the purge erased exactly the listed projects in the team, no more and no fewer');
  assert.equal(deleted.personal_projects_elsewhere, listed.length);
});

test('a personal project the person cannot read is erased and the email says it is missing', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Grove team');
  const member = await makePerson('Mika');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });
  const readable = mark('MIKAREADABLE');
  await makeProject(member, owner.orgId, `Mika personal ${RUN}`, 'personal', { current_task: `Mine ${readable}` });
  // Stamped with an API key id: the purge's identity set includes it, the
  // person's own read (by user id) does not see it.
  const keyId = `key-${crypto.randomUUID()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, 'dd_test', $2, 'elsewhere', $3, $4, 'production', now() + interval '1 year', $5)`,
    [keyId, `hash-${crypto.randomUUID()}`, member.userId, owner.orgId, ['context:read']]
  );
  const keyStamped = `proj-${crypto.randomUUID()}`;
  await q(
    `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name)
     VALUES ($1, $2, $3, 'personal', $4)`,
    [keyStamped, owner.orgId, keyId, `Mika key-stamped ${RUN}`]
  );

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(attachment.includes(readable), 'what can be read is carried');
  assert.equal(await projectExists(keyStamped), false, 'the unreadable one is erased all the same');
  assert.match(html, /It also leaves out one of your personal projects in other workspaces, which could not be read\./,
    'and the email says one is missing, rather than calling the copy complete');
  assert.match(section(attachment, `Personal projects in ${owner.name} (1)`) || '', /1 more of your personal projects in this workspace could not be read/,
    'as does the attachment, in that workspace\'s block');
});

// ── the rest of what the purge takes from other workspaces ──────────────────
//
// Besides personal projects, the person-keyed half of the purge erases two more
// things a person WROTE inside other people's workspaces: their "you" profile
// there (context_globals is keyed by workspace AND person; PERSON_KEYED_DELETES
// context_globals_by_person) and the graph notes marked private to them
// (erasePrivateNodesElsewhere). Both are theirs alone, and both went with no copy.

test('a member\'s profile and private notes in a team are in the attachment; the team node a note links to is not', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Isle team');
  const member = await makePerson('Moss');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const M = {
    profile: mark('MOSSPROFILE'),
    style: mark('MOSSSTYLE'),
    noteOne: mark('MOSSNOTEONE'),
    noteOneSummary: mark('MOSSNOTEONESUMMARY'),
    noteTwo: mark('MOSSNOTETWO'),
    noteTwoSummary: mark('MOSSNOTETWOSUMMARY'),
  };
  const NOT = {
    teamNode: mark('TEAMNODE'),
    edge: mark('NOTELINKSUMMARY'),
    sharedTask: mark('ISLESHAREDTASK'),
    ownerProfile: mark('OWNERPROFILE'),
  };
  await service.updateGlobalContext(member.as(owner.orgId), { user_profile: `In the team I ${M.profile}`, working_style: `Pairs ${M.style}` });
  await service.updateGlobalContext(owner.as(owner.orgId), { user_profile: `The owner ${NOT.ownerProfile}` });
  const sharedName = `Isle shared ${RUN}`;
  const shared = await makeProject(owner, owner.orgId, sharedName, 'shared', { current_task: `Team work ${NOT.sharedTask}` });
  const teamNode = await seedWorkspaceNode(owner.orgId, `Team node ${NOT.teamNode}`);
  // One note at workspace level, linked to a team node; one on the team's
  // shared project, which the member reads.
  const noteOne = await seedWorkspaceNode(owner.orgId, `Moss note ${M.noteOne}`, { private_to: member.userId }, { summary: `Why ${M.noteOneSummary}` });
  await seedEdge(owner.orgId, noteOne, teamNode, `Moss note leans on ${NOT.edge}`);
  const noteTwo = await seedWorkspaceNode(owner.orgId, `Moss note ${M.noteTwo}`, { private_to: member.userId }, { summary: `How ${M.noteTwoSummary}`, projectId: shared });

  // Preconditions: the member reads the team node and the shared project, so
  // their absence below is the export's doing and not the reader's.
  const readable = JSON.stringify(await service.exportContext(member.as(owner.orgId)));
  for (const marker of [NOT.teamNode, NOT.sharedTask, M.noteOne, M.noteTwo]) {
    assert.ok(readable.includes(marker), `precondition: the member reads ${marker} in the team`);
  }

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);

  const profile = section(attachment, `Your profile in ${owner.name}`);
  assert.ok(profile, `the profile has a block headed with the team's name; the attachment had:\n${attachment.split('\n').filter((l) => l.startsWith('## ')).join('\n')}`);
  assert.ok(profile.includes(M.profile) && profile.includes(M.style), 'with what the member wrote there');
  const notes = section(attachment, `Private notes in ${owner.name} (2)`);
  assert.ok(notes, 'the private notes have a block headed with the team\'s name');
  for (const marker of [M.noteOne, M.noteOneSummary, M.noteTwo, M.noteTwoSummary]) {
    assert.ok(notes.includes(marker), `a note's own text is carried (${marker})`);
  }
  // Titles are re-cased on read ("Moss Note ..."), so the type line is matched
  // without regard to case.
  assert.match(notes, new RegExp(`- knowledge: moss note ${M.noteOne}`, 'i'), 'with its type');
  assert.ok(notes.includes(`Project: ${sharedName}`), 'a note on a project the member reads names that project');
  assert.equal(section(attachment, `Personal projects in ${owner.name}`), null, 'no empty projects block for a workspace where they kept none');

  const leaked = Object.entries(NOT).filter(([, marker]) => attachment.includes(marker)).map(([label]) => label);
  assert.deepEqual(leaked, [], 'not the team node a note links to, the link, the shared project\'s text, or a colleague\'s profile');
  assert.deepEqual(exportMarkdown.unaccountedKeys(renderedBundle), [], 'every new key is rendered or deliberately listed as not rendered');

  assert.match(html, new RegExp(`It also carries your profile and 2 private notes you kept in ${owner.name}, under that workspace's name; that workspace's shared and private projects stay with it and are not attached\\.`),
    'the email says what else is attached');
  assert.match(html, new RegExp(`It also leaves out the links from your private notes to the rest of the knowledge graph in ${owner.name}\\.`),
    'and that what the notes linked to is not');
  assert.match(html, /a full Markdown export/, 'nothing the purge takes is missing');

  // The purge is unchanged: the member's rows go, the team's stay.
  assert.equal(await profileExists(owner.orgId, member.userId), false, 'the member\'s profile in the team is erased');
  assert.equal(await nodeExists(noteOne.node_id), false, 'the workspace-level note is erased');
  assert.equal(await nodeExists(noteTwo.node_id), false, 'the note on the shared project is erased');
  assert.equal(await profileExists(owner.orgId, owner.userId), true, 'the owner\'s profile stays');
  assert.equal(await nodeExists(teamNode.node_id), true, 'the team node stays');
  assert.equal(await projectExists(shared), true, 'the shared project stays');
});

// ── a personal project's links do not carry the team's text (round 3, D-1) ──
//
// getProjectGraph hands back the FAR END of every edge filed in a project, so a
// personal project whose note links to one of the team's entities brought that
// entity's title and summary into the attachment, printed under a heading that
// says the team's work stays with the team (the walker's s3-link-probe). The
// test above links a private NOTE to a team node, never a personal PROJECT's
// node, so it missed this. Links are written the way the product writes them:
// `relations` on an entity upsert, as POST /workspace/entities and the hosted
// manage_memory upsert both take them.

// The `### ` subsection of `block` whose heading begins with `heading`.
function subsection(block, heading) {
  const lines = (block || '').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${heading}`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('a personal project\'s links to the team\'s entities do not carry the team\'s text into the attachment', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Osprey team');
  const member = await makePerson('Pax');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const M = {
    note: mark('PAXNOTE'),
    noteSummary: mark('PAXNOTESUMMARY'),
    other: mark('PAXOTHER'),
    otherSummary: mark('PAXOTHERSUMMARY'),
    linkOwn: mark('PAXLINKOWN'),
    privateNote: mark('PAXPRIVATE'),
    privateNoteSummary: mark('PAXPRIVATESUMMARY'),
  };
  const NOT = {
    teamFact: mark('TEAMFACT'),
    teamFactSummary: mark('TEAMFACTSUMMARY'),
    sharedFact: mark('SHAREDFACT'),
    sharedFactSummary: mark('SHAREDFACTSUMMARY'),
    // The member's own words on the links to the team's entities. They are
    // left out with the link, and the email says so.
    linkTeam: mark('PAXLINKTEAM'),
    linkShared: mark('PAXLINKSHARED'),
  };
  const key = (label) => `knowledge:${label.toLowerCase()}-${RUN.toLowerCase()}`;
  const K = { team: key('teamfact'), shared: key('sharedfact'), note: key('paxnote'), other: key('paxother') };

  const shared = await makeProject(owner, owner.orgId, `Osprey shared ${RUN}`, 'shared', { current_task: 'team work' });
  const personalName = `Pax notes ${RUN}`;
  const otherName = `Pax other ${RUN}`;
  const personal = await makeProject(member, owner.orgId, personalName, 'personal', { current_task: 'mine' });
  const other = await makeProject(member, owner.orgId, otherName, 'personal', { current_task: 'also mine' });

  // (a) the team's workspace-level entity, (b) an entity of the team's shared
  // project, (c) an entity of the member's OWN other personal project there.
  await service.upsertWorkspaceEntities(owner.as(owner.orgId), {
    entities: [{ title: `Team fact ${NOT.teamFact}`, entity_type: 'knowledge', summary: `The team's own fact ${NOT.teamFactSummary} about billing`, scope: 'workspace', canonical_key: K.team }],
  });
  await service.upsertWorkspaceEntities(owner.as(owner.orgId), {
    project_id: shared,
    entities: [{ title: `Shared fact ${NOT.sharedFact}`, entity_type: 'knowledge', summary: `Team words ${NOT.sharedFactSummary} in a shared project`, scope: 'project', project_id: shared, canonical_key: K.shared }],
  });
  await service.upsertWorkspaceEntities(member.as(owner.orgId), {
    project_id: other,
    entities: [{ title: `Pax other ${M.other}`, entity_type: 'knowledge', summary: `My other words ${M.otherSummary}`, scope: 'project', project_id: other, canonical_key: K.other }],
  });
  // (d) a note marked private to the member at workspace level: theirs, and
  // carried in its own block, so a link to it from a personal project is left
  // out like any other link out of the project, and the note is not lost.
  const privateNote = await seedWorkspaceNode(owner.orgId, `Pax private ${M.privateNote}`, { private_to: member.userId }, { summary: `Kept to myself ${M.privateNoteSummary}` });
  // The endpoints by the keys they were stored under, so each relation lands.
  const storedKey = async (projectId, marker) => (await q(
    'SELECT canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND project_id IS NOT DISTINCT FROM $2 AND title ILIKE $3',
    [owner.orgId, projectId, `%${marker}%`]
  ))[0]?.canonical_key;
  const targets = {
    team: await storedKey(null, NOT.teamFact),
    shared: await storedKey(shared, NOT.sharedFact),
    other: await storedKey(other, M.other),
    privateNote: await storedKey(null, M.privateNote),
  };
  assert.ok(Object.values(targets).every(Boolean), `precondition: every entity was written (${JSON.stringify(targets)})`);

  const written = await service.upsertWorkspaceEntities(member.as(owner.orgId), {
    project_id: personal,
    entities: [{ title: `Pax note ${M.note}`, entity_type: 'knowledge', summary: `My own words ${M.noteSummary}`, scope: 'project', project_id: personal, canonical_key: K.note }],
    relations: [
      { from_canonical_key: K.note, to_canonical_key: targets.team, relation_type: 'related_to', summary: `leans on the team fact ${NOT.linkTeam}` },
      { from_canonical_key: K.note, to_canonical_key: targets.shared, relation_type: 'related_to', summary: `leans on the shared fact ${NOT.linkShared}` },
      { from_canonical_key: K.note, to_canonical_key: targets.other, relation_type: 'related_to', summary: `leans on my other note ${M.linkOwn}` },
      { from_canonical_key: K.note, to_canonical_key: targets.privateNote, relation_type: 'related_to', summary: 'leans on my private note' },
    ],
  });
  assert.equal((written.relations || []).length, 4, `precondition: all four links were recorded (${JSON.stringify(written.unresolved_relations)})`);

  // Preconditions: the member reads (a) and (b), and the ordinary export (the
  // Settings > Data download while bound to the team) still prints them inside
  // the personal project's graph. That export is not changed here: this is the
  // doorway, and only the deletion attachment closes it.
  const ordinary = await service.exportContext(member.as(owner.orgId));
  const ordinaryPersonal = JSON.stringify(ordinary.projects.find((p) => p.project_id === personal));
  for (const marker of [NOT.teamFact, NOT.teamFactSummary, NOT.sharedFact, NOT.sharedFactSummary]) {
    assert.ok(ordinaryPersonal.includes(marker), `precondition: the personal project's graph reaches ${marker} in the ordinary export`);
  }

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);

  const block = section(attachment, `Personal projects in ${owner.name} (2)`);
  assert.ok(block, `both personal projects are carried under the team's name; the attachment had:\n${attachment.split('\n').filter((l) => l.startsWith('## ')).join('\n')}`);
  const mine = subsection(block, personalName);
  const theOther = subsection(block, otherName);
  assert.ok(mine && theOther, 'each project has its own heading');

  // (a) and (b): nowhere, by title or by summary, and not the link that named them.
  const leaked = Object.entries(NOT).filter(([, marker]) => attachment.includes(marker) || html.includes(marker)).map(([label]) => label);
  assert.deepEqual(leaked, [], 'nothing of the team\'s entities is in the attachment or the email');

  // The project's own node is carried, with its words.
  assert.ok(mine.includes(M.note) && mine.includes(M.noteSummary), 'the personal project\'s own note is carried');
  // (c): the member's own entity is carried ONCE, with its own project, and the
  // link between the two, the member's words from one of their projects to the
  // other, all erased with the account, stays with the project it is filed in.
  assert.ok(theOther.includes(M.other) && theOther.includes(M.otherSummary), 'the other project\'s entity is carried under its own project');
  assert.equal(attachment.split(M.otherSummary).length - 1, 1, 'and printed once, not again inside the project that links to it');
  assert.match(mine, new RegExp(`${M.note}.* related_to .*${M.other}.*${M.linkOwn}`, 'i'), 'the link between the member\'s own projects is carried, naming both ends');
  assert.match(mine, /3 links from this project to the rest of that workspace's knowledge graph are not in this export\./,
    'the project says how many of its links are left out: to (a), (b) and (d)');
  // (d): the private note is carried once, in its own block, in its own words.
  const notes = section(attachment, `Private notes in ${owner.name} (1)`);
  assert.ok(notes && notes.includes(M.privateNote) && notes.includes(M.privateNoteSummary), 'the linked private note is carried in the notes block');
  assert.equal(attachment.split(M.privateNoteSummary).length - 1, 1, 'once, and not inside the project that links to it');
  assert.deepEqual(exportMarkdown.unaccountedKeys(renderedBundle), [], 'every key of the carried block is rendered or deliberately listed');

  // The email: still what it said, plus that the links are left out.
  assert.match(html, new RegExp(`It also carries the 2 personal projects and a private note you kept in ${owner.name}, under that workspace's name; that workspace's shared and private projects stay with it and are not attached\\.`));
  assert.match(html, new RegExp(`It also leaves out the links from one of your personal projects and your private note to the rest of the knowledge graph in ${owner.name}\\.`),
    'the email says the links to the rest of the knowledge graph are left out');
  assert.match(html, /a full Markdown export/, 'as it does for a private note\'s links, the copy is still called full: nothing the purge takes is missing but the links, which it names');

  // The purge is unchanged: the member's projects and note go, the team's entities stay.
  assert.equal(await projectExists(personal), false);
  assert.equal(await projectExists(other), false);
  assert.equal(await nodeExists(privateNote.node_id), false);
  assert.equal(await projectExists(shared), true);
  const teamRows = await q('SELECT title FROM context_graph_nodes WHERE owner_key = $1 AND (title ILIKE $2 OR title ILIKE $3)', [owner.orgId, `%${NOT.teamFact}%`, `%${NOT.sharedFact}%`]);
  assert.equal(teamRows.length, 2, 'both team entities stay with the team');
});

test('a private note names its project only if the person can read it, and one they cannot read is counted', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Jade team');
  const member = await makePerson('Mack');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });

  const seen = mark('MACKSEENNOTE');
  const hidden = mark('MACKHIDDENNOTE');
  const NOT = {
    privateName: mark('JADEPRIVATENAME'),
    privateTask: mark('JADEPRIVATETASK'),
    excerpt: mark('SIGHTINGEXCERPT'),
  };
  // The owner's org-private project: the member cannot open it.
  const ownersPrivate = await makeProject(owner, owner.orgId, `Owner plan ${NOT.privateName}`, 'private', { current_task: `Plan ${NOT.privateTask}` });
  const shared = await makeProject(owner, owner.orgId, `Jade shared ${RUN}`, 'shared', { current_task: 'team work' });
  // Homed on that private project, but also seen in the shared one: the member
  // reads it there, and the project it sits on is not theirs to name.
  const seenNote = await seedWorkspaceNode(owner.orgId, `Mack note ${seen}`, { private_to: member.userId }, { projectId: ownersPrivate });
  await seedEvidence(owner.orgId, seenNote, shared, `said in a session ${NOT.excerpt}`);
  // Homed on it and seen nowhere else: the graph filter does not show it to
  // the member at all.
  const hiddenNote = await seedWorkspaceNode(owner.orgId, `Mack note ${hidden}`, { private_to: member.userId }, { projectId: ownersPrivate });

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const notes = section(attachment, `Private notes in ${owner.name} (1)`);
  assert.ok(notes && notes.includes(seen), 'the note the member reads is carried');
  assert.ok(!notes.includes('Project:'), 'without naming a project the member cannot open');
  assert.ok(!attachment.includes(hidden), 'the one the member cannot read is not');
  assert.match(notes, /1 more of your private notes in this workspace could not be read/, 'it is counted in the block');
  const leaked = Object.entries(NOT).filter(([, marker]) => attachment.includes(marker)).map(([label]) => label);
  assert.deepEqual(leaked, [], 'nothing of the project it sat on, and no conversation excerpt');
  assert.match(html, /It also leaves out one of your private notes in other workspaces, which could not be read\./, 'and in the email');
  assert.doesNotMatch(html, /a full Markdown export/);
  assert.equal(await nodeExists(seenNote.node_id), false, 'both are erased');
  assert.equal(await nodeExists(hiddenNote.node_id), false);
  assert.equal(await projectExists(ownersPrivate), true, 'the project they sat on stays');
});

test('listProfilesElsewhere names exactly the profiles the purge then erases', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const first = await makePerson('Kelp team');
  const second = await makePerson('Lark team');
  const member = await makePerson('Nia');
  await workspace.addMember(first.orgId, member.userId, { role: 'member' });
  await workspace.addMember(second.orgId, member.userId, { role: 'member' });
  await service.updateGlobalContext(member.as(member.orgId), { user_profile: 'at home: the home sweep takes this' });
  await service.updateGlobalContext(member.as(first.orgId), { user_profile: 'in the first team' });
  await service.updateGlobalContext(member.as(second.orgId), { user_profile: 'in the second team' });
  await service.updateGlobalContext(first.as(first.orgId), { user_profile: 'the first team\'s owner' });

  const listed = await erasure.listProfilesElsewhere(member.orgId, { userIds: [member.userId] });
  const key = (row) => `${row.owner_key}/${row.person_id}`;
  assert.deepEqual(listed.map(key).sort(), [`${first.orgId}/${member.userId}`, `${second.orgId}/${member.userId}`].sort(),
    'her profile in each other workspace, and nobody else\'s');

  const rowsIn = async () => new Set((await q('SELECT owner_key, person_id FROM context_globals WHERE owner_key = ANY($1)', [[first.orgId, second.orgId]])).map(key));
  const before = await rowsIn();
  const deleted = await erasure.purgeOwnerData(member.orgId);
  const afterRows = await rowsIn();
  assert.deepEqual([...before].filter((row) => !afterRows.has(row)).sort(), listed.map(key).sort(),
    'the purge erased exactly the listed profiles in other workspaces');
  assert.equal(deleted.context_globals_by_person, listed.length, 'and the eraser counted exactly those');
});

test('listPrivateNodesElsewhere names exactly the private notes the purge then erases', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Moor team');
  const member = await makePerson('Noor');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });
  const shared = await makeProject(owner, owner.orgId, `Moor shared ${RUN}`, 'shared', { current_task: 'team work' });
  const keyId = `key-${crypto.randomUUID()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, 'dd_test', $2, 'elsewhere', $3, $4, 'production', now() + interval '1 year', $5)`,
    [keyId, `hash-${crypto.randomUUID()}`, member.userId, owner.orgId, ['context:read']]
  );
  const mine = [
    await seedWorkspaceNode(owner.orgId, `Noor note one ${RUN}`, { private_to: member.userId }),
    await seedWorkspaceNode(owner.orgId, `Noor note two ${RUN}`, { private_to: member.userId }, { projectId: shared }),
    // Marked with one of her key ids: the eraser matches every id she is
    // stamped under.
    await seedWorkspaceNode(owner.orgId, `Noor note by key ${RUN}`, { private_to: keyId }),
  ];
  await seedWorkspaceNode(owner.orgId, `Owner note ${RUN}`, { private_to: owner.userId });
  await seedWorkspaceNode(owner.orgId, `Team fact ${RUN}`);
  await seedWorkspaceNode(member.orgId, `Noor note at home ${RUN}`, { private_to: member.userId });

  const listed = await erasure.listPrivateNodesElsewhere(member.orgId, { userIds: [member.userId] });
  assert.deepEqual(listed.map((row) => row.node_id).sort(), mine.map((node) => node.node_id).sort(),
    'her marked notes outside her own workspace, by every id she is stamped under');
  assert.ok(listed.every((row) => row.owner_key === owner.orgId), 'each with the workspace it lives in');

  const nodesIn = async () => new Set((await q('SELECT node_id FROM context_graph_nodes WHERE owner_key = $1', [owner.orgId])).map((row) => row.node_id));
  const before = await nodesIn();
  const deleted = await erasure.purgeOwnerData(member.orgId);
  const afterNodes = await nodesIn();
  assert.deepEqual([...before].filter((id) => !afterNodes.has(id)).sort(), listed.map((row) => row.node_id).sort(),
    'the purge erased exactly the listed notes in the team');
  assert.equal(deleted.private_to_context_graph_nodes, listed.length, 'and the eraser counted exactly those');
});

// ── a solo account is untouched ─────────────────────────────────────────────

// The attachment DELETE /orgs produced for this exact seed on the commit this
// change is built on (67b13045), with every ISO timestamp replaced by
// <timestamp>. Regenerate only on purpose: WRITE_EXPORT_FIXTURE=1.
// One phrase of the email changed on purpose since (journey scan round 3): the
// graph's evidence rows no longer hold conversation excerpts, so the email names
// them as "the notes on where your knowledge graph came from". And one phrase
// went (journey scan round 4): switched-off skills are attached now, so "any
// skills you had switched off" is no longer among what the email says is left out.
const SOLO_FIXTURE = path.join(__dirname, '..', 'fixtures', 'account-delete-export', 'solo-attachment.md');
const BASE_EMAIL_HTML =
  '<p>As requested before deleting your account, attached is a full Markdown export of your DeerDawn context — your profile, every project including archived ones, their task boards, notes and knowledge graph, and your skills.</p>' +
  '<p>It is a copy of what was stored, so it leaves out the edit, session and activity history behind it, the notes on where your knowledge graph came from, and the search indexes and rankings DeerDawn computes from your data.</p>' +
  '<p>This is a copy of your data, made just before deletion. Once your account is deleted, it is the last copy we hold.</p>';
const normalize = (markdown) => markdown.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>');

test('a solo account\'s attachment and email are byte for byte what they were before this change', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const solo = await makePerson('Solo');
  const me = solo.as();
  // Fixed text throughout: the names are unique only within this fresh
  // workspace, so the attachment does not depend on the run.
  await service.updateGlobalContext(me, { user_profile: 'Solo builds export pipelines', working_style: 'Small commits' });
  const live = await makeProject(solo, solo.orgId, 'Solo live project', null, {
    description: 'The live project',
    goals: ['Ship the importer'],
    tech_stack: ['Postgres'],
    current_task: 'Write the renderer',
    current_status: 'Halfway',
    recent_decisions: [{ summary: 'Render from keys', decided_at: '2026-09-01T00:00:00.000Z' }],
    open_questions: ['Cache the bundle?'],
    add_todos: [
      { title: 'Backlog card', body: 'The detail of the card', phase: 'backlog' },
      { title: 'Done card', phase: 'done' },
    ],
  });
  await service.recordDebugFinding(me, live, { summary: 'The cache collides under load', paths: ['src/cache.js'] });
  await service.recordHotPaths(me, live, [{ label: 'export route', path: 'src/routes/export.js' }]);
  await addEntity(solo, solo.orgId, live, 'Export pipeline');
  const old = await makeProject(solo, solo.orgId, 'Solo archived project', null, { current_task: 'Finish the old work' });
  await service.archiveProject(me, old);
  await service.upsertWorkspaceEntities(me, {
    entities: [{ title: 'Shared platform', entity_type: 'component', summary: 'Runs every export and import job for the workspace', scope: 'workspace' }],
  });
  await service.upsertSkill(me, { name: 'Release', description: 'How we release', markdown_content: '# Releasing\n\nTag, then deploy.\n' });

  const { res, attachment, html } = await deleteAccount(solo);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);

  const actual = normalize(attachment);
  if (process.env.WRITE_EXPORT_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(SOLO_FIXTURE), { recursive: true });
    fs.writeFileSync(SOLO_FIXTURE, actual);
  }
  assert.equal(actual, fs.readFileSync(SOLO_FIXTURE, 'utf-8'), 'the solo attachment is unchanged');
  assert.equal(html, BASE_EMAIL_HTML, 'and so is the email');
});

// ── the email tells the truth about what is attached ────────────────────────

test('projects that could not be decrypted are counted in the email, which stops calling the copy full', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Harbor team');
  const member = await makePerson('Milo');
  await workspace.addMember(owner.orgId, member.userId, { role: 'member' });
  const home = await makeProject(member, member.orgId, `Milo at home ${RUN}`, null, { current_task: 'home work' });
  const readable = mark('MILOREADABLE');
  await makeProject(member, member.orgId, `Milo readable ${RUN}`, null, { current_task: `Fine ${readable}` });
  const inTeam = await makeProject(member, owner.orgId, `Milo personal ${RUN}`, 'personal', { current_task: 'team notes' });
  await corrupt(member.orgId, home);
  await corrupt(owner.orgId, inTeam);

  const { res, attachment, html } = await deleteAccount(member, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true, 'the deletion is not blocked, and the export still goes');
  assert.ok(attachment.includes(readable), 'what could be read is attached');
  assert.equal((attachment.match(/could not be decrypted/g) || []).length, 2, 'the attachment marks both, as it always has');
  assert.match(html, /2 projects could not be decrypted, so their context is missing from the attachment/, 'the email says how many');
  assert.doesNotMatch(html, /a full Markdown export/, 'and does not call a copy with holes in it full');
  assert.match(html, /attached is a Markdown export of your DeerDawn context/);
});

// ── a workspace that closes with the account IS attached (journey r5) ───────
//
// Round 1's BLOCKED 9: a side workspace only the person is in closes with the
// account and is erased whole, and it used to be left out of the "last copy we
// hold". The owner's decision: it is attached, in a block of its own, apart from
// the person's own workspace and from every other one. A workspace with other
// people in it never closes with the account, so it is neither erased nor
// attached.

// Real work in a side workspace: shared, personal and archived projects, a
// board card, a workspace entity, a skill and the person's profile there.
async function fillSideWorkspace(person, side, label) {
  const M = {
    live: mark(`${label}LIVE`),
    personal: mark(`${label}PERSONAL`),
    archived: mark(`${label}ARCHIVED`),
    card: mark(`${label}CARD`),
    entity: mark(`${label}ENTITY`),
    skill: mark(`${label}SKILL`),
    profile: mark(`${label}PROFILE`),
  };
  const live = await makeProject(person, side.orgId, `${label} live ${RUN}`, null, {
    current_task: `Live work ${M.live}`,
    add_todos: [{ title: `Card ${M.card}`, phase: 'backlog' }],
  });
  await makeProject(person, side.orgId, `${label} personal ${RUN}`, 'personal', { current_task: `Personal work ${M.personal}` });
  const old = await makeProject(person, side.orgId, `${label} archived ${RUN}`, null, { current_task: `Old work ${M.archived}` });
  await service.archiveProject(person.as(side.orgId), old);
  await service.upsertWorkspaceEntities(person.as(side.orgId), {
    entities: [{ title: `${label} platform ${M.entity}`, entity_type: 'component', summary: 'Runs every job for the side workspace', scope: 'workspace' }],
  });
  await service.upsertSkill(person.as(side.orgId), { name: `${label} skill ${RUN}`, description: 'How', markdown_content: `# Steps\n\nRun ${M.skill} first.\n` });
  await service.updateGlobalContext(person.as(side.orgId), { user_profile: `Profile in ${label} ${M.profile}` });
  return { M, live };
}

test('a sole-member side workspace that closes with the account is in the attachment, whole, under its own name', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Nell');
  const side = await makeSideWorkspace(person, 'Nell side workspace');
  const home = mark('NELLHOME');
  await makeProject(person, person.orgId, `Nell home ${RUN}`, null, { current_task: `Home ${home}` });
  const { M, live } = await fillSideWorkspace(person, side, 'NELLSIDE');

  const { res, attachment, html } = await deleteAccount(person);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.export_emailed, true);
  assert.deepEqual(res.body.closed_workspaces.map((ws) => ws.workspace), [side.orgId], 'precondition: the side workspace closes with the account');
  assert.equal(await projectExists(live), false, 'and it is erased');

  assert.ok(attachment.includes(home), 'the home workspace is attached, as before');
  const block = section(attachment, `Workspace closing with your account: ${side.name}`);
  assert.ok(block, `the attachment has a block headed with the closed workspace's name; it had:\n${attachment.split('\n').filter((l) => l.startsWith('## ')).join('\n')}`);
  for (const [label, marker] of Object.entries(M)) {
    assert.ok(block.includes(marker), `the closed workspace's ${label} is in its block`);
  }
  assert.ok(!block.includes(home), 'and the home workspace is not inside it');
  assert.ok(!attachment.slice(0, attachment.indexOf(`## Workspace closing with your account: ${side.name}`)).includes(M.live), 'nor is it printed before it, among the home workspace\'s projects');
  assert.deepEqual(exportMarkdown.unaccountedKeys(renderedBundle), [], 'every key of the closed workspace is rendered or deliberately listed as not rendered');

  // The email tells the truth: it is attached, under its name, and it is a full copy.
  assert.match(html, new RegExp(`It also carries the workspace ${side.name}, which closes with your account because nobody else is in it: its profile, projects, task boards, notes, knowledge graph and skills are attached under that workspace's name, and will be erased with the account\\.`));
  assert.doesNotMatch(html, /are not attached|is not attached/, 'nothing it says is missing');
  assert.doesNotMatch(html, /It does not include/, 'and the old sentence is gone');
  assert.match(html, /attached is a full Markdown export of your DeerDawn context — your profile, every project in your own workspace including archived ones/);
  // The receipt in the reply still says what happened.
  assert.match(res.body.message, /along with 1 other workspace only you belonged to\./);
});

test('two closing workspaces are two blocks, each holding only its own work', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Otto');
  const sideB = await makeSideWorkspace(person, 'Otto Beta side');
  const sideA = await makeSideWorkspace(person, 'Otto Alpha side');
  const A = await fillSideWorkspace(person, sideA, 'OTTOALPHA');
  const B = await fillSideWorkspace(person, sideB, 'OTTOBETA');

  const { res, attachment, html } = await deleteAccount(person);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.closed_workspaces.length, 2);

  const blockA = section(attachment, `Workspace closing with your account: ${sideA.name}`);
  const blockB = section(attachment, `Workspace closing with your account: ${sideB.name}`);
  assert.ok(blockA && blockB, 'each closed workspace has its own block');
  assert.ok(attachment.indexOf(blockA) < attachment.indexOf(blockB), 'in name order, not the order they were made');
  for (const marker of Object.values(A.M)) {
    assert.ok(blockA.includes(marker) && !blockB.includes(marker), `${marker} is in Alpha's block and not Beta's`);
  }
  for (const marker of Object.values(B.M)) {
    assert.ok(blockB.includes(marker) && !blockA.includes(marker), `${marker} is in Beta's block and not Alpha's`);
  }
  assert.match(html, new RegExp(`It also carries the workspaces ${sideA.name} and ${sideB.name}, which close with your account because nobody else is in them: their profiles, projects, task boards, notes, knowledge graph and skills are attached, each under the name of its workspace, and will be erased with the account\\.`));
});

test('a team workspace with another member is not exported and not erased; only the sole-member one is', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Harbor crew');
  const coOwner = await makePerson('Pia');
  const person = await makePerson('Quin');
  await workspace.addMember(owner.orgId, person.userId, { role: 'member' });
  // A second team where the person is an OWNER, with another owner beside them:
  // the account can be closed (they are not its only owner) and it stays.
  await workspace.addMember(coOwner.orgId, person.userId, { role: 'owner' });
  const side = await makeSideWorkspace(person, 'Quin side workspace');

  const TEAM = { shared: mark('CREWSHARED'), co: mark('COOWNERSHARED'), sideWork: mark('QUINSIDEWORK') };
  const teamShared = await makeProject(owner, owner.orgId, `Crew shared ${RUN}`, 'shared', { current_task: `Crew ${TEAM.shared}` });
  const coShared = await makeProject(person, coOwner.orgId, `Quin in co-owned ${RUN}`, 'shared', { current_task: `Co-owned ${TEAM.co}` });
  const sideProject = await makeProject(person, side.orgId, `Quin side ${RUN}`, null, { current_task: `Side ${TEAM.sideWork}` });

  const { res, attachment, html } = await deleteAccount(person);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.closed_workspaces.map((ws) => ws.workspace), [side.orgId], 'only the workspace nobody else is in closes');

  assert.ok(attachment.includes(TEAM.sideWork), 'the sole-member workspace is attached');
  assert.ok(!attachment.includes(TEAM.shared) && !attachment.includes(TEAM.co), 'the teams with other people are not');
  assert.equal(section(attachment, `Workspace closing with your account: ${owner.name}`), null);
  assert.equal(section(attachment, `Workspace closing with your account: ${coOwner.name}`), null);
  assert.equal(await projectExists(sideProject), false, 'the sole-member workspace is erased');
  assert.equal(await projectExists(teamShared), true, 'the team\'s shared project stays with the team');
  assert.equal(await projectExists(coShared), true, 'so does the co-owned team\'s');
  assert.doesNotMatch(html, new RegExp(owner.name), 'and the email does not name a team that stays');
});

test('a closing workspace that cannot be read stops the export, and with it the deletion', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Rae');
  const side = await makeSideWorkspace(person, 'Rae side workspace');
  const sideProject = await makeProject(person, side.orgId, `Rae side ${RUN}`, null, { current_task: 'Side work' });
  const real = service.exportContext;
  service.exportContext = async (who, ...rest) => {
    if (who?.workspace_key === side.orgId) throw new Error('read failed');
    return real(who, ...rest);
  };
  try {
    const { res, mail } = await deleteAccount(person);
    assert.equal(mail, undefined, 'no export email went out');
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.error, 'export_not_sent');
    assert.equal(await projectExists(sideProject), true, 'and nothing was deleted');
  } finally {
    service.exportContext = real;
  }
});

// ── a failed export stops the deletion (journey r5) ─────────────────────────
//
// The owner's decision on round 1's BLOCKED 9: when the person asked for the
// export and it was not sent, nothing is deleted, the reply says why, and the
// dashboard offers a retry. Asked for it means email_export; without it the
// deletion is exactly what it was.

const userExists = async (userId) => (await q('SELECT 1 FROM users WHERE user_id = $1', [userId])).length === 1;

test('an export that is not sent stops the deletion: nothing deleted, nothing billed, and a retry works', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Sol');
  const side = await makeSideWorkspace(person, 'Sol side workspace');
  const home = await makeProject(person, person.orgId, `Sol home ${RUN}`, null, { current_task: 'Home work' });
  const sideProject = await makeProject(person, side.orgId, `Sol side ${RUN}`, null, { current_task: 'Side work' });

  sendResult = { ok: false, status: 500 };
  try {
    const failed = await deleteAccount(person);
    assert.equal(failed.res.status, 502, JSON.stringify(failed.res.body));
    assert.equal(failed.res.body.error, 'export_not_sent');
    assert.equal(failed.res.body.retryable, true);
    assert.match(failed.res.body.message, /could not be emailed, so nothing was deleted\. Try again, or turn off the export option to delete without one\./);
    assert.equal(await projectExists(home), true, 'the home workspace is intact');
    assert.equal(await projectExists(sideProject), true, 'so is the side workspace');
    assert.equal(await userExists(person.userId), true, 'and the account');
    assert.deepEqual(cancelled, [], 'no subscription was cancelled');

    // The transport that is not configured is not a send either.
    sendResult = { skipped: true, reason: 'no_api_key' };
    const skipped = await deleteAccount(person);
    assert.equal(skipped.res.status, 502, JSON.stringify(skipped.res.body));
    assert.equal(await projectExists(home), true);
  } finally {
    sendResult = { ok: true };
  }

  // The retry: the workspaces were not left marked closing, so it goes through.
  const retry = await deleteAccount(person);
  assert.equal(retry.res.status, 200, JSON.stringify(retry.res.body));
  assert.equal(retry.res.body.export_emailed, true);
  assert.deepEqual(retry.res.body.closed_workspaces.map((ws) => ws.workspace), [side.orgId]);
  assert.equal(await projectExists(home), false);
  assert.equal(await projectExists(sideProject), false);
  assert.equal(await userExists(person.userId), false);
});

test('without the export option the deletion needs no email', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Tam');
  const home = await makeProject(person, person.orgId, `Tam home ${RUN}`, null, { current_task: 'Home work' });
  sendResult = { ok: false, status: 500 };
  try {
    const { res, mail } = await deleteAccount(person, person.orgId, { emailExport: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.export_emailed, false);
    assert.equal(mail, undefined);
    assert.equal(await projectExists(home), false);
  } finally {
    sendResult = { ok: true };
  }
});

// ── the email is true at the moment it is sent (journey r5 review, M3) ──────
//
// The export goes out BEFORE billing is cancelled and the data is purged, so it
// must not say anything that is only true afterwards: not that the data "has now
// been erased", and not that a workspace "closed". The person learns the outcome
// from the reply in the dashboard.

const ERASURE_CLAIMS = /has now been erased|erased from DeerDawn|were erased|was erased|closed with your account|last copy we hold\. Your/;

test('the export email and attachment claim no erasure that has not happened', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const owner = await makePerson('Vale team');
  const person = await makePerson('Ivo');
  await workspace.addMember(owner.orgId, person.userId, { role: 'member' });
  const side = await makeSideWorkspace(person, 'Ivo side workspace');
  await fillSideWorkspace(person, side, 'IVOSIDE');
  await makeProject(person, owner.orgId, `Ivo personal ${RUN}`, 'personal', { current_task: 'Team notes' });
  const { res, html, attachment } = await deleteAccount(person, owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.doesNotMatch(html, ERASURE_CLAIMS, `the email is true before anything is deleted:\n${html}`);
  assert.doesNotMatch(attachment, /\b(was|were) erased\b|closed with your account/, 'and so is the attachment');
  assert.match(html, /This is a copy of your data, made just before deletion\. Once your account is deleted, it is the last copy we hold\./);
  assert.match(html, /will be erased with the account/, 'what will happen is said in the future tense');
  assert.match(attachment, /erased when your account is deleted/, 'the attachment says the same of what it carries from other workspaces');
});

test('a billing cancel that fails after the export was emailed leaves everything intact, and the reply says so', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'account-delete export elsewhere'))) return;
  const person = await makePerson('Uma');
  const side = await makeSideWorkspace(person, 'Uma side workspace');
  const home = await makeProject(person, person.orgId, `Uma home ${RUN}`, null, { current_task: 'Home work' });
  const sideProject = await makeProject(person, side.orgId, `Uma side ${RUN}`, null, { current_task: 'Side work' });

  cancelResult = { ok: false, reason: 'stripe unavailable' };
  try {
    const { res, mail, html } = await deleteAccount(person);
    assert.ok(mail, 'the export was already emailed');
    assert.doesNotMatch(html, ERASURE_CLAIMS, 'and it says nothing has been erased');
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.error, 'billing_cancellation_failed');
    assert.equal(res.body.export_emailed, true);
    assert.match(res.body.message, /nothing was deleted/);
    assert.match(res.body.message, /The export we emailed you is only a copy: your account is intact\./);
    assert.equal(await projectExists(home), true);
    assert.equal(await projectExists(sideProject), true);
    assert.equal(await userExists(person.userId), true);
  } finally {
    cancelResult = { ok: true, cancelled: false };
  }
  const retry = await deleteAccount(person);
  assert.equal(retry.res.status, 200, JSON.stringify(retry.res.body));
  assert.equal(await userExists(person.userId), false);
});

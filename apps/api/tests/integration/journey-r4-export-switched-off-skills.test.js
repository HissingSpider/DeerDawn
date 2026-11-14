/**
 * JOURNEY R4 — THE EXPORT CARRIES SWITCHED-OFF SKILLS.
 *
 * A skill a person switched off was left out of the download ("Everything
 * DeerDawn holds for you") and then erased at account deletion with no copy
 * anywhere: the store lists enabled skills only, and the export read skills
 * through that listing. The owner's decision: switched-off skills go into the
 * export, JSON and Markdown, marked as switched off, and the account-deletion
 * attachment follows the same rule (its carried personal projects included).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r4-export-switched-off-skills.test.js
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
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const { renderContextExportMarkdown } = require('../../src/services/contextExportMarkdown');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const tag = () => uuidv4().slice(0, 8);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'free', 'free', 'active', null],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${tag()}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, jwt, actor: { type: 'user', id: userId, org_id: orgId, workspace_key: orgId, role: 'admin' } };
}

const as = (method, path, person) => request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);

async function seedSkill(person, { name, enabled, projectId = null }) {
  return store.upsertWorkspaceSkill({
    skill_id: `skill_${uuidv4()}`,
    owner_key: person.orgId,
    project_id: projectId,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tag()}`,
    name,
    description: `${name} description`,
    markdown_content: `# ${name}\n\nThe body of ${name}.`,
    visibility: 'private',
    enabled,
    created_by: person.userId,
  });
}

test('THE BUG: a switched-off skill is in the JSON download, marked as switched off', async () => {
  const person = await makePerson('r4-skills-json');
  const created = await as('post', '/api/v1/context/projects', person).send({ project_name: `Skills project ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.project.project_id;
  const on = await seedSkill(person, { name: 'Release checklist', enabled: true });
  const off = await seedSkill(person, { name: 'Old deploy steps', enabled: false });
  const offInProject = await seedSkill(person, { name: 'Project migration notes', enabled: false, projectId });

  const res = await as('get', '/api/v1/context/export', person);
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const bundle = JSON.parse(res.text);
  const byId = new Map((bundle.skills || []).map((s) => [s.skill_id, s]));
  assert.ok(byId.has(off.skill_id), 'THE BUG: a switched-off skill was left out of the download, and erased at deletion with no copy');
  assert.equal(byId.get(off.skill_id).enabled, false, 'marked as switched off');
  assert.equal(byId.get(off.skill_id).markdown_content, '# Old deploy steps\n\nThe body of Old deploy steps.', 'with its body');
  assert.ok(byId.has(offInProject.skill_id), 'a project\'s switched-off skill too');
  assert.equal(byId.get(offInProject.skill_id).enabled, false);
  assert.equal(byId.get(on.skill_id).enabled, true, 'a skill that is on is still there, marked on');
  assert.equal(bundle.skills.length, 3, 'each once');
});

test('the Markdown download prints a switched-off skill under a heading that says so', async () => {
  const person = await makePerson('r4-skills-md');
  await seedSkill(person, { name: 'Old deploy steps', enabled: false });
  const res = await as('get', '/api/v1/context/export?format=markdown', person);
  assert.equal(res.status, 200);
  assert.match(res.text, /### Old deploy steps \(switched off\)/);
  assert.match(res.text, /The body of Old deploy steps\./);
});

test('what an assistant or a teammate reads is unchanged: switched-off skills stay out of the skill listing', async () => {
  const person = await makePerson('r4-skills-listing');
  const off = await seedSkill(person, { name: 'Old deploy steps', enabled: false });
  const listed = await service.listWorkspaceSkills(person.orgId, { actor: person.actor });
  assert.ok(!listed.some((s) => s.skill_id === off.skill_id), 'switching a skill off still keeps it out of every session');
});

test('the account-deletion attachment follows the same rule, for a personal project carried from a team', async () => {
  const person = await makePerson('r4-skills-carried');
  const created = await as('post', '/api/v1/context/projects', person).send({ project_name: `Carried ${tag()}` });
  const projectId = created.body.project.project_id;
  const off = await seedSkill(person, { name: 'Carried switched-off skill', enabled: false, projectId });
  // The carried read (routes/shared/orgs.js emailContextExport) is exportContext with projectIds.
  const bundle = await service.exportContext(person.actor, { projectIds: [projectId] });
  const skill = (bundle.skills || []).find((s) => s.skill_id === off.skill_id);
  assert.ok(skill, 'a switched-off skill in a carried project travels with it');
  assert.equal(skill.enabled, false);
  const md = renderContextExportMarkdown({ ...bundle, other_workspaces: [] });
  assert.match(md, /Carried switched-off skill \(switched off\)/);
});

test('the deletion email no longer tells the person switched-off skills are left out', () => {
  const fs = require('fs');
  const path = require('path');
  const orgs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'shared', 'orgs.js'), 'utf8');
  assert.doesNotMatch(orgs, /any skills you had switched off/);
});

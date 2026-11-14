/**
 * Name lookups must not reach — or echo — a project the actor cannot see.
 *
 * findProjectByName and findProjectCandidatesByName both read
 * store.listProjectIdentifiers, which selected every row for the owner_key with
 * no visibility filter at all. Two consequences, both on paths a normal user
 * hits without trying:
 *
 *   - createProject's duplicate-name gate refused the create and named the
 *     colliding project in its public message: `a project named "Acme
 *     Rebrand" already exists (project_…)`. On a shared workspace that message
 *     is a colleague's PERSONAL project's name and id, handed to somebody who
 *     may not read it — and a project name is frequently a client's name.
 *   - the hosted MCP name→id resolver refused the whole call as ambiguous and
 *     listed every candidate by name and id, for the same reason.
 *
 * The visibility rules already existed (canViewProjectForActor, listProjects's
 * actorIdentities); these lookups simply did not use them, because they took an
 * owner KEY — which answers "which workspace" and cannot answer "which of its
 * projects may this person see".
 *
 * The reproduction on the old code is the createProject case below: it is the
 * one leak reachable through a signature that did not change. The rest pin the
 * scoping contract the fix introduces, in both directions — an author must still
 * resolve her own project by name, or this would have traded a leak for a
 * different silent failure.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/project-name-lookup-visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-namevis-alice-${RUN}`;
const BOB = `user-namevis-bob-${RUN}`;

const alice = () => ({ org_id: ORG, id: ALICE });
const bob = () => ({ org_id: ORG, id: BOB });

const PERSONAL_NAME = `Acme Rebrand ${RUN}`;
const SHARED_NAME = `Team Platform ${RUN}`;

let bobPersonal;
let sharedProject;

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });

  bobPersonal = await service.createProject(bob(), { project_name: PERSONAL_NAME });
  const row = await store.getProject(ORG, bobPersonal.project_id);
  await store.saveProject({ ...row, visibility: 'personal' }, null);

  sharedProject = await service.createProject(bob(), { project_name: SHARED_NAME });
});

test.after(async () => {
  try {
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system');
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a colleague\'s personal project does not answer a name lookup', async () => {
  const found = await service.findProjectByName(alice(), PERSONAL_NAME);
  assert.equal(found, null, 'Alice resolved a project she is not allowed to read');
});

test('its author still resolves her own project by name', async () => {
  const found = await service.findProjectByName(bob(), PERSONAL_NAME);
  assert.equal(found?.project_id, bobPersonal.project_id, 'the author must still find her own');
});

test('a shared project is still resolvable by everyone in the workspace', async () => {
  const found = await service.findProjectByName(alice(), SHARED_NAME);
  assert.equal(found?.project_id, sharedProject.project_id);
});

test('creating a project does not echo a colleague\'s personal project name or id', async () => {
  let created = null;
  try {
    created = await service.createProject(alice(), { project_name: PERSONAL_NAME });
  } catch (err) {
    assert.ok(
      !String(err.publicMessage || err.message).includes(bobPersonal.project_id),
      `the duplicate-name refusal echoed a hidden project id: ${err.publicMessage || err.message}`
    );
    assert.fail(`the create was refused by an invisible project: ${err.publicMessage || err.message}`);
  }
  assert.ok(created?.project_id, 'Alice gets her own project with that name');
  assert.notEqual(created.project_id, bobPersonal.project_id, 'and it is a new row, not a merge');
});

test('the name→id resolver does not list a colleague\'s personal project', async () => {
  const candidates = await service.findProjectCandidatesByName(alice(), PERSONAL_NAME);
  const ids = candidates.map((c) => c.project_id);
  assert.ok(!ids.includes(bobPersonal.project_id), 'the ambiguity message would have named a hidden project');
});

test('the author still gets her own candidate from the resolver', async () => {
  const candidates = await service.findProjectCandidatesByName(bob(), PERSONAL_NAME);
  assert.ok(
    candidates.some((c) => c.project_id === bobPersonal.project_id),
    'scoping must not blind the author to her own project'
  );
});

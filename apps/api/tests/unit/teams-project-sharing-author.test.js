'use strict';

// Who may change where a project lives — the 2026-09 scan, defect 4.
//
// Three surfaces answered this and no two agreed:
//
//   PATCH /teams/projects/:id/sharing  checked canAdminister and nothing else.
//     So a MEMBER could never share their own project (the one person with any
//     claim to that decision), and an OWNER's PATCH on a colleague's PERSONAL
//     project returned 200 and published it — contradicting the single rule
//     `personal` exists to state: its author, and nobody else, not even a
//     workspace owner.
//
//   GET /teams/projects/:id/access     checked NOTHING. Any member could name
//     any project id in the workspace and be told its name and visibility,
//     a colleague's personal project included.
//
//   GET /teams/projects-sharing        filtered correctly, but reported nothing
//     about who could act, so the dashboard offered the dropdown to everybody
//     and answered every refusal with "Could not change that."
//
// Behavioural, through the real router with db and workspaceService stubbed —
// the same harness shape as teams-setup-defects.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const ORG = 'org-team';
let currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: ORG };

const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
  req.actor = { ...currentActor };
  next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.getEntitlements = async () => ({ limits: {}, features: { team_management: true } });

// The projects this workspace holds, addressed by id.
const projects = new Map();
const writes = [];

// Flipped by the tests that assert a READ FAILURE is a 5xx and never a 404.
const faults = { projectRead: false, roleRead: false };

const db = require('../../src/config/db');
db.query = async (sql, params) => {
  if (/FROM context_projects\s+WHERE project_id = \$1 AND owner_key = \$2/.test(sql)) {
    if (faults.projectRead) throw new Error('connection terminated unexpectedly');
    const project = projects.get(params[0]);
    return { rows: project && project.owner_key === params[1] ? [project] : [] };
  }
  if (/SELECT project_id, owner_key, owner_user_id, visibility, project_name, updated_at/.test(sql)) {
    return { rows: [...projects.values()].filter((p) => p.owner_key === params[0]) };
  }
  if (/UPDATE context_projects/.test(sql)) {
    writes.push({ sql, params });
    const project = projects.get(params[1]);
    if (project) project.visibility = params[0];
    return { rowCount: project ? 1 : 0, rows: [] };
  }
  if (/FROM context_audit_logs/.test(sql)) return { rows: [] };
  if (/INSERT INTO context_audit_logs/.test(sql)) return { rows: [] };
  return { rows: [] };
};

const contextStore = require('../../src/store/contextSyncStore');
contextStore.getProjectShare = async () => ({ share: null, sections: [], members: [] });
contextStore.upsertProjectShare = async (projectId, payload) => {
  writes.push({ share: projectId, payload });
};

const workspace = require('../../src/services/workspaceService');
const roles = {};
workspace.resolveRole = async (actor) => {
  if (faults.roleRead) throw new Error('connection terminated unexpectedly');
  return roles[actor.id] || 'viewer';
};
// The ACTIVE roster. "The author has left" is "the author is not in it" (removed,
// erased, or a legacy owner id that never had a row), so a test that wants the
// author to be a member must list them here.
let activeRoster = ['user-owner', 'user-member', 'user-viewer'];
workspace.listMembers = async () => activeRoster.map((user_id) => ({ user_id, removed_at: null, active: true }));

const teamsRouter = require('../../src/routes/shared/teams');

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/teams', teamsRouter);
  return app;
}

function reset() {
  projects.clear();
  writes.length = 0;
  faults.projectRead = false;
  faults.roleRead = false;
  activeRoster = ['user-owner', 'user-member', 'user-viewer'];
  for (const key of Object.keys(roles)) delete roles[key];
  roles['user-owner'] = 'owner';
  roles['user-member'] = 'member';
  roles['user-viewer'] = 'viewer';
  currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: ORG };
}

function addProject(project_id, owner_user_id, visibility, project_name = project_id) {
  projects.set(project_id, {
    project_id,
    project_name,
    owner_key: ORG,
    owner_user_id,
    visibility,
    updated_at: new Date().toISOString(),
  });
}

const as = (id) => { currentActor = { id, org_id: 'org-personal', workspace_key: ORG }; };

// --- PATCH /projects/:id/sharing -------------------------------------------

test('a member can share the project they authored', async () => {
  reset();
  addProject('p-mine', 'user-member', 'private');
  as('user-member');

  const res = await request(appWith()).patch('/teams/projects/p-mine/sharing').send({ visibility: 'shared' });

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.visibility, 'shared');
  assert.strictEqual(projects.get('p-mine').visibility, 'shared');
});

test('a member cannot change a colleague\'s shared project, and is told why', async () => {
  reset();
  addProject('p-theirs', 'user-owner', 'shared');
  as('user-member');

  const res = await request(appWith()).patch('/teams/projects/p-theirs/sharing').send({ visibility: 'private' });

  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.message, /author or a workspace owner/i);
  assert.strictEqual(projects.get('p-theirs').visibility, 'shared', 'nothing was moved');
});

test('a viewer cannot change anything, their own project included', async () => {
  reset();
  addProject('p-viewer', 'user-viewer', 'private');
  as('user-viewer');

  const res = await request(appWith()).patch('/teams/projects/p-viewer/sharing').send({ visibility: 'shared' });

  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.message, /viewer/i);
  assert.strictEqual(projects.get('p-viewer').visibility, 'private');
});

test('an owner cannot flip a colleague\'s personal project, and is not told it exists', async () => {
  reset();
  addProject('p-personal', 'user-member', 'personal');
  as('user-owner');

  const res = await request(appWith()).patch('/teams/projects/p-personal/sharing').send({ visibility: 'shared' });

  // 404, not 403: a refusal that confirms the project exists is itself the
  // disclosure `personal` is meant to prevent.
  assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'project_not_found');
  assert.strictEqual(projects.get('p-personal').visibility, 'personal', 'it stays personal');
  assert.strictEqual(writes.length, 0, 'nothing was written at all');
});

test('the author of a personal project can still un-personal it', async () => {
  reset();
  addProject('p-personal', 'user-member', 'personal');
  as('user-member');

  const res = await request(appWith()).patch('/teams/projects/p-personal/sharing').send({ visibility: 'shared' });

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(projects.get('p-personal').visibility, 'shared');
});

// Journey r6 (owner's decision): a colleague's PRIVATE project is its author's to
// share while they are a member; a workspace owner holds that once the author has
// left. A colleague's SHARED project an owner may still make private. This test
// used to move a colleague's private project to shared as an owner while the
// author was a member.
test('an owner still makes a colleague\'s shared project private, but shares their private one only once the author has left', async () => {
  reset();
  addProject('p-shared', 'user-member', 'shared');
  as('user-owner');

  const back = await request(appWith()).patch('/teams/projects/p-shared/sharing').send({ visibility: 'private' });
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  assert.strictEqual(projects.get('p-shared').visibility, 'private');

  // Private now, and its author is still a member: sharing it is the author's call.
  const refused = await request(appWith()).patch('/teams/projects/p-shared/sharing').send({ visibility: 'shared' });
  assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
  assert.match(refused.body.message, /private project.*author is still in the workspace/i);
  assert.strictEqual(projects.get('p-shared').visibility, 'private');

  // The author has left the workspace (no active membership): the owner may.
  activeRoster = ['user-owner', 'user-viewer'];
  const shared = await request(appWith()).patch('/teams/projects/p-shared/sharing').send({ visibility: 'shared' });
  assert.strictEqual(shared.status, 200, JSON.stringify(shared.body));
  assert.strictEqual(projects.get('p-shared').visibility, 'shared');
});

test('an unattributed project belongs to the workspace, so only an owner moves it', async () => {
  reset();
  addProject('p-orphan', null, 'private');

  as('user-member');
  const refused = await request(appWith()).patch('/teams/projects/p-orphan/sharing').send({ visibility: 'shared' });
  assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
  assert.match(refused.body.message, /no author/i);

  as('user-owner');
  const allowed = await request(appWith()).patch('/teams/projects/p-orphan/sharing').send({ visibility: 'shared' });
  assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
});

// --- GET /projects-sharing --------------------------------------------------

test('the listing says, per project, whether this person may change it', async () => {
  reset();
  addProject('p-mine', 'user-member', 'private');
  addProject('p-theirs', 'user-owner', 'shared');
  addProject('p-secret', 'user-owner', 'personal');
  as('user-member');

  const res = await request(appWith()).get('/teams/projects-sharing');

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const byId = new Map(res.body.projects.map((p) => [p.project_id, p]));
  assert.ok(!byId.has('p-secret'), 'a colleague\'s personal project is not listed at all');
  assert.strictEqual(byId.get('p-mine').can_change_visibility, true);
  assert.strictEqual(byId.get('p-mine').visibility_locked_reason, null);
  assert.strictEqual(byId.get('p-theirs').can_change_visibility, false);
  assert.match(byId.get('p-theirs').visibility_locked_reason, /author or a workspace owner/i);
});

// --- GET /projects/:id/access -----------------------------------------------

test('project access applies the same visibility rule as the listing', async () => {
  reset();
  addProject('p-secret', 'user-owner', 'personal', 'Owner side project');
  addProject('p-shared', 'user-owner', 'shared', 'Team project');
  as('user-member');

  const hidden = await request(appWith()).get('/teams/projects/p-secret/access');
  assert.strictEqual(hidden.status, 404, JSON.stringify(hidden.body));
  assert.ok(
    !JSON.stringify(hidden.body).includes('Owner side project'),
    'the refusal must not leak the name it is refusing',
  );

  const visible = await request(appWith()).get('/teams/projects/p-shared/access');
  assert.strictEqual(visible.status, 200, JSON.stringify(visible.body));
  assert.strictEqual(visible.body.project_name, 'Team project');
});

test('an owner cannot read a colleague\'s personal project through /access either', async () => {
  reset();
  addProject('p-secret', 'user-member', 'personal', 'Member side project');
  as('user-owner');

  const res = await request(appWith()).get('/teams/projects/p-secret/access');
  assert.strictEqual(res.status, 404, JSON.stringify(res.body));
});

// --- rows that predate any of this -----------------------------------------

test('an unattributed project stays manageable by an owner, whatever its visibility', async () => {
  // THE HOLE THE FIRST VERSION OF THIS RULE HAD. `personal` is a promise made to
  // a PERSON. A row with owner_user_id NULL — a legacy project, one created by
  // an internal actor, anything predating per-user attribution — has no such
  // person, and applying the personal guard to it made the project permanently
  // unmanageable: refused to every member AND to every owner, with no author who
  // could ever come and change it. It also 404'd out of a PATCH that
  // mayReadProject had just let through, which is two functions disagreeing
  // about the same row.
  reset();
  addProject('p-orphan-personal', null, 'personal');
  as('user-owner');

  const res = await request(appWith())
    .patch('/teams/projects/p-orphan-personal/sharing')
    .send({ visibility: 'shared' });

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(projects.get('p-orphan-personal').visibility, 'shared');
});

test('an unattributed project is still not a member\'s to move', async () => {
  reset();
  addProject('p-orphan-personal', null, 'personal');
  as('user-member');

  const res = await request(appWith())
    .patch('/teams/projects/p-orphan-personal/sharing')
    .send({ visibility: 'shared' });

  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.message, /no author/i);
  assert.strictEqual(projects.get('p-orphan-personal').visibility, 'personal');
});

test('a row with no visibility is read as private, which is the column default', async () => {
  // context_projects.visibility is NOT NULL DEFAULT 'private', so this reaches
  // the rule only from a projection that omitted it — and a row in no branch at
  // all is worse than a row in the wrong one.
  reset();
  addProject('p-nullvis', 'user-member', null);

  // Read as private WITH an author who is still a member: since journey r6 that
  // is the author's to share, not an owner's (an owner shares it once the author
  // has left, and the listing says so).
  as('user-owner');
  const owner = await request(appWith()).patch('/teams/projects/p-nullvis/sharing').send({ visibility: 'shared' });
  assert.strictEqual(owner.status, 403, JSON.stringify(owner.body));
  assert.match(owner.body.message, /private project/i);
  as('user-member');
  const author = await request(appWith()).patch('/teams/projects/p-nullvis/sharing').send({ visibility: 'shared' });
  assert.strictEqual(author.status, 200, JSON.stringify(author.body));

  reset();
  addProject('p-nullvis', 'user-owner', null);
  as('user-member');
  const member = await request(appWith()).patch('/teams/projects/p-nullvis/sharing').send({ visibility: 'shared' });
  // Private, so it is not even visible to a member who did not write it.
  assert.strictEqual(member.status, 404, JSON.stringify(member.body));

  // A legacy row with no author AND no visibility belongs to the workspace, and an
  // owner still manages it: it does not become unmanageable by everybody.
  reset();
  addProject('p-legacy', null, null);
  as('user-owner');
  const legacy = await request(appWith()).patch('/teams/projects/p-legacy/sharing').send({ visibility: 'shared' });
  assert.strictEqual(legacy.status, 200, JSON.stringify(legacy.body));
});

// --- a failed read is not an answer ----------------------------------------

test('a failed project read answers 5xx, never "not found"', async () => {
  reset();
  addProject('p-mine', 'user-member', 'private');
  as('user-member');
  faults.projectRead = true;

  const res = await request(appWith()).patch('/teams/projects/p-mine/sharing').send({ visibility: 'shared' });

  assert.ok(res.status >= 500, `expected 5xx, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.strictEqual(writes.length, 0, 'and nothing was written');
});

test('a failed role read answers 5xx, never "you are a viewer"', async () => {
  // Swallowing this would tell an owner, on the strength of a database error,
  // that they had been demoted — and tell nobody that anything failed.
  reset();
  addProject('p-theirs', 'user-owner', 'shared');
  as('user-owner');
  faults.roleRead = true;

  const res = await request(appWith()).patch('/teams/projects/p-theirs/sharing').send({ visibility: 'private' });

  assert.ok(res.status >= 500, `expected 5xx, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.strictEqual(projects.get('p-theirs').visibility, 'shared');
});

test('a failed role read does not turn a listing into a shorter one', async () => {
  reset();
  addProject('p-theirs', 'user-owner', 'private');
  as('user-owner');
  faults.roleRead = true;

  const res = await request(appWith()).get('/teams/projects-sharing');
  assert.ok(res.status >= 500, `expected 5xx, got ${res.status} ${JSON.stringify(res.body)}`);
});

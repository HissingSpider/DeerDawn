'use strict';

/**
 * THE COMMITTED FILE IS THE ONE COPIED BEFORE ANYBODY JOINED.
 *
 * GET /teams/workspace-config emits DEERDAWN_WORKSPACE only for a workspace
 * that is already shared, which it asked as "more than one active member". The
 * natural order is create the team, pay, COMMIT THE FILE, then invite: at the
 * moment the file is copied the workspace holds exactly one person, so the id
 * was left out and the committed .mcp.json is the solo one forever. The
 * teammate the mechanism exists for — somebody who already had DeerDawn, whose
 * saved key is valid and personal, so setup never re-runs the device flow —
 * then lands in their own empty workspace while the same response tells them to
 * "use the team's .mcp.json".
 *
 * The no-credential promise is unchanged and pinned separately in
 * teams-multi-user.test.js; this only decides whether the identifier is there.
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const PERSON = 'user-config-reader';
const PERSONAL = 'org-personal-config';
const TEAM = 'org-team-config';

// The workspace under test, rebuilt per case.
let state = {};

const db = require('../../src/config/db');
db.query = async (text) => {
  if (/FROM organizations/.test(text)) return { rows: [{ name: state.name || 'Acme' }] };
  return { rows: [] };
};

const entitlements = require('../../src/services/entitlementService');
entitlements.getEntitlements = async () => ({
  limits: {},
  features: { team_management: state.teamPlan === true },
});

const workspace = require('../../src/services/workspaceService');
workspace.isSharedWorkspace = async () => state.shared === true;
workspace.listInvites = async () => state.invites || [];

// requireAuth is replaced wholesale: this test is about what the handler emits,
// not about how an actor is built, and the real middleware wants a credential.
const auth = require('../../src/middleware/auth');
auth.requireAuth = (req, _res, next) => {
  req.actor = { type: 'user', id: PERSON, org_id: state.actorOrg, workspace_key: state.bound };
  next();
};

delete require.cache[require.resolve('../../src/routes/shared/teams')];
const teams = require('../../src/routes/shared/teams');
const app = express();
app.use(express.json());
app.use('/api/v1/teams', teams);

const fetchConfig = () => request(app).get('/api/v1/teams/workspace-config');
const contentsOf = (res) => res.body?.files?.[0]?.contents || '';

test.beforeEach(() => {
  state = { actorOrg: PERSONAL, bound: TEAM, shared: false, teamPlan: false, invites: [], name: 'Acme' };
});

test('a paid team names itself before the second person arrives', async () => {
  state.teamPlan = true;
  state.bound = PERSONAL;
  state.actorOrg = PERSONAL;
  const res = await fetchConfig();
  assert.equal(res.status, 200);
  assert.match(
    contentsOf(res),
    new RegExp(`"DEERDAWN_WORKSPACE": "${PERSONAL}"`),
    'THE BUG: the file copied right after paying carried no workspace id',
  );
});

test('an invitation already out is enough, paid plan or not', async () => {
  state.bound = PERSONAL;
  state.invites = [{ invite_id: 'inv-1', email: 'colleague@acme.com' }];
  const res = await fetchConfig();
  assert.match(contentsOf(res), new RegExp(`"DEERDAWN_WORKSPACE": "${PERSONAL}"`));
});

test('a workspace that is not the org this person signed up under names itself', async () => {
  // A team created but not yet paid for, entered through the switcher.
  const res = await fetchConfig();
  assert.match(contentsOf(res), new RegExp(`"DEERDAWN_WORKSPACE": "${TEAM}"`));
});

test('a workspace that already holds a team still names itself', async () => {
  state.bound = PERSONAL;
  state.shared = true;
  const res = await fetchConfig();
  assert.match(contentsOf(res), new RegExp(`"DEERDAWN_WORKSPACE": "${PERSONAL}"`));
});

test('a genuinely personal workspace still gets no id, and no credential ever', async () => {
  state.bound = PERSONAL;
  const res = await fetchConfig();
  const contents = contentsOf(res);
  assert.doesNotMatch(contents, /DEERDAWN_WORKSPACE/, 'nothing to point a solo account at');
  assert.doesNotMatch(contents, /API_KEY/i, 'the file exists to be committed');
  assert.doesNotMatch(contents, /dd_[A-Za-z0-9]/, 'no key material of any shape');
  assert.equal(res.body.contains_secrets, false);
});

test('the verify text and the file agree about which case this is', async () => {
  state.teamPlan = true;
  state.bound = PERSONAL;
  const res = await fetchConfig();
  assert.match(contentsOf(res), /DEERDAWN_WORKSPACE/);
  assert.match(
    res.body.verify,
    /lands in this workspace/,
    'the wording that tells a teammate to use the team file has to be the wording that ships the id',
  );
});

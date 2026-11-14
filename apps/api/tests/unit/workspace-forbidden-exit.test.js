'use strict';

// REFUSING THE ENTRANCE MUST NOT ALSO REFUSE THE EXIT.
//
// Anybody whose users.org_id IS a team workspace — the legacy invite path
// created people directly inside the target org — is refused on EVERY request
// once removed, header or no header. The dashboard drops its stored workspace,
// retries against the account default, and gets the same 403 forever: a screen
// whose only button cannot succeed.
//
// GET /api/v1/teams/workspaces is the route that answers "where may I go
// instead", so it stays reachable while barred. Nothing else does.

process.env.NODE_ENV = 'test';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const TEAM = 'org-legacy-team';
const OTHER = 'org-other-team';
const PERSON = 'user-legacy-member';

const keys = new Map();
const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/FROM api_keys WHERE key_hash/.test(text)) {
    const row = keys.get(params[0]);
    return { rows: row ? [row] : [] };
  }
  return { rows: [] };
};

const apiKeyCache = require('../../src/services/apiKeyCache');
const cache = new Map();
apiKeyCache.getApiKey = (hash) => cache.get(hash) || null;
apiKeyCache.setApiKey = (hash, row) => { cache.set(hash, row); };

const workspace = require('../../src/services/workspaceService');
let removed = true;
let activeWorkspace = null;
let memberships = [];
workspace.isRemovedFrom = async () => removed;
workspace.getActiveWorkspace = async () => activeWorkspace;
workspace.listMemberships = async () => memberships;
workspace.getMembership = async (ownerKey, userId) => (
  memberships.some((m) => m.owner_key === ownerKey) ? { owner_key: ownerKey, user_id: userId, role: 'member' } : null
);

const { hashApiKey } = require('../../src/utils/security');
const { requireAuth } = require('../../src/middleware/auth');

// Mirrors the real mount: the teams router sits at /api/v1/teams and applies
// requireAuth itself, so req.baseUrl + req.path is the full path.
const teams = express.Router();
teams.use(requireAuth);
teams.get('/workspaces', (req, res) => res.json({
  active: workspace.defaultOwnerKey(req.actor),
  workspaces: memberships.map((m) => ({ workspace: m.owner_key })),
}));
teams.get('/members', (_req, res) => res.json({ members: [] }));
teams.post('/workspaces', (_req, res) => res.json({ created: true }));
const app = express();
app.use(express.json());
app.use('/api/v1/teams', teams);
app.get('/api/v1/context/projects', requireAuth, (_req, res) => res.json({ projects: [] }));

const TOKEN = 'dd_live_exitroute_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function seedKey() {
  keys.set(hashApiKey(TOKEN), {
    key_id: 'key-exitroute',
    owner_id: PERSON,
    org_id: TEAM,
    environment: 'production',
    scopes: ['context:read', 'context:write'],
    oauth_resource: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    status: 'active',
  });
}
const get = (path) => request(app).get(path).set('Authorization', `Bearer ${TOKEN}`);

beforeEach(() => {
  keys.clear();
  cache.clear();
  removed = true;
  activeWorkspace = null;
  memberships = [];
  seedKey();
});

test('a removed legacy member is still refused everywhere else', async () => {
  const roster = await get('/api/v1/teams/members');
  assert.strictEqual(roster.status, 403);
  assert.strictEqual(roster.body.error, 'workspace_forbidden');

  const projects = await get('/api/v1/context/projects');
  assert.strictEqual(projects.status, 403, 'the removal check still governs the product');
});

test('but the workspace listing — the only route that says where to go — answers', async () => {
  memberships = [{ owner_key: OTHER, role: 'member' }];
  const res = await get('/api/v1/teams/workspaces');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.workspaces.map((w) => w.workspace), [OTHER]);
});

test('the exemption is the listing GET alone, not the path', async () => {
  const created = await request(app)
    .post('/api/v1/teams/workspaces')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ name: 'new' });
  assert.strictEqual(created.status, 403, 'a barred member may ask where to go, not create somewhere to go');
});

test('nothing changes for somebody who was never removed', async () => {
  removed = false;
  assert.strictEqual((await get('/api/v1/teams/members')).status, 200);
  assert.strictEqual((await get('/api/v1/teams/workspaces')).status, 200);
});

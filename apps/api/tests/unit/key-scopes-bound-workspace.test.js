'use strict';

// A credential's scopes are capped by the person's role in the workspace the
// REQUEST is bound to — decided per request, not baked in at mint.
//
// Capping at mint/refresh resolved the role in the person's ACTIVE workspace and
// wrote the result into the token. A viewer on a team therefore got a read-only
// token that also governed their PERSONAL workspace, for the token's whole life.
// The token now carries what the person approved; bindWorkspace narrows it to the
// role held where each request actually lands, so the personal workspace stays
// fully writable and a demotion bites on the very next request.
//
// The fixture stamps the team key with the TEAM's org_id, which is what keys.js
// and the device flow do. It used to stamp the personal org and rely on the
// is_active row to carry the request into the team — that fallback is now only
// for credentials that cannot name a workspace (OAuth tokens, dashboard
// sessions), because letting an ordinary key follow it moved somebody's personal
// key into the team the moment they accepted an invite. Which workspace a
// request lands in is that fix's business; what these tests are about is the
// ceiling applied once it has landed.

process.env.NODE_ENV = 'test';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const PERSONAL = 'org-viewer-personal';
const TEAM = 'org-team';
const PERSON = 'user-viewer';

const keys = new Map(); // hash -> row
const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/FROM api_keys WHERE key_hash/.test(text)) {
    const row = keys.get(params[0]);
    return { rows: row ? [row] : [] };
  }
  // resolveOwnerKey calls the module's OWN getMembership, not the export the
  // roster below replaces, so the header path has to be answered here or every
  // explicit x-deerdawn-workspace resolves to "not a member".
  // The person's own org (workspaceService.personalWorkspaceKey): a key's
  // workspace is no longer taken to BE its holder's own account, so the
  // no-membership-row exception reads users.org_id like production does.
  if (/SELECT org_id FROM users WHERE user_id/.test(text)) {
    return { rows: params[0] === PERSON ? [{ org_id: homeOrg }] : [] };
  }
  if (/FROM workspace_members/.test(text)) {
    const role = roster.get(`${params[0]}|${params[1]}`);
    return { rows: role ? [{ owner_key: params[0], user_id: params[1], role }] : [] };
  }
  return { rows: [] };
};

const apiKeyCache = require('../../src/services/apiKeyCache');
const cache = new Map();
apiKeyCache.getApiKey = (hash) => cache.get(hash) || null;
apiKeyCache.setApiKey = (hash, row) => { cache.set(hash, row); };

const workspace = require('../../src/services/workspaceService');
let activeWorkspace = null;
let roster = new Map();
let homeOrg = PERSONAL;
workspace.getActiveWorkspace = async () => activeWorkspace;
workspace.isRemovedFrom = async () => false;
workspace.getMembership = async (ownerKey, userId) => {
  const role = roster.get(`${ownerKey}|${userId}`);
  return role ? { owner_key: ownerKey, user_id: userId, role } : null;
};
// The cap reads the person's WHOLE membership list now rather than one row: the
// same index and the same single round trip, and routes/mcp.js needs the other
// entries to tell a plain key holder which workspace this key cannot reach. The
// ceiling these tests are about is unchanged; only where the role is read from.
workspace.listMemberships = async (userId) => [...roster.entries()]
  .filter(([key]) => key.endsWith(`|${userId}`))
  .map(([key, role]) => ({ owner_key: key.split('|')[0], role }));

const { hashApiKey } = require('../../src/utils/security');
const { requireAuth } = require('../../src/middleware/auth');

const app = express();
app.get('/probe', requireAuth, (req, res) => {
  res.json({ workspace: workspace.defaultOwnerKey(req.actor), scopes: req.actor.scopes });
});

function seedKey(token, { orgId = TEAM, ownerId = PERSON, scopes = ['context:read', 'context:write'], oauth = null } = {}) {
  keys.set(hashApiKey(token), {
    key_id: `key-${token.slice(-6)}`,
    owner_id: ownerId,
    org_id: orgId,
    environment: 'production',
    scopes,
    oauth_resource: oauth,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    status: 'active',
  });
}

beforeEach(() => {
  homeOrg = PERSONAL;
  keys.clear();
  cache.clear();
  activeWorkspace = TEAM;
  roster = new Map([
    [`${PERSONAL}|${PERSON}`, 'owner'],
    [`${TEAM}|${PERSON}`, 'viewer'],
  ]);
});

const TOKEN = 'dd_live_scopecap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('a team viewer\'s token is read-only while bound to the team', async () => {
  seedKey(TOKEN);
  const res = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.workspace, TEAM);
  assert.deepStrictEqual(res.body.scopes, ['context:read']);
});

test('the same token keeps write in the person\'s personal workspace', async () => {
  seedKey(TOKEN);
  const res = await request(app).get('/probe')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('x-deerdawn-workspace', PERSONAL);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.workspace, PERSONAL);
  assert.deepStrictEqual(res.body.scopes, ['context:read', 'context:write']);

  // And a key of their own, minted at home, is not narrowed by the team either.
  const HOME_TOKEN = 'dd_live_scopecap_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  seedKey(HOME_TOKEN, { orgId: PERSONAL });
  const home = await request(app).get('/probe').set('Authorization', `Bearer ${HOME_TOKEN}`);
  assert.strictEqual(home.body.workspace, PERSONAL);
  assert.deepStrictEqual(home.body.scopes, ['context:read', 'context:write']);
});

test('a demotion takes effect on the next request, with no refresh', async () => {
  seedKey(TOKEN);
  roster.set(`${TEAM}|${PERSON}`, 'member');
  const before = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(before.body.scopes, ['context:read', 'context:write']);

  roster.set(`${TEAM}|${PERSON}`, 'viewer');
  const after = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(after.body.scopes, ['context:read'], 'the cached key row must not carry the old scopes');

  roster.set(`${TEAM}|${PERSON}`, 'member');
  const again = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(again.body.scopes, ['context:read', 'context:write'], 'narrowing never mutates the stored scopes');
});

test('a write-only scope still reads for a viewer; admin implies write for a member', async () => {
  seedKey(TOKEN, { scopes: ['context:write'] });
  const viewer = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(viewer.body.scopes, ['context:read']);

  cache.clear();
  seedKey(TOKEN, { scopes: ['context:admin'] });
  roster.set(`${TEAM}|${PERSON}`, 'member');
  const member = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(member.body.scopes, ['context:read', 'context:write']);
});

test('somebody in their own account with no membership row is not narrowed', async () => {
  activeWorkspace = null;
  roster = new Map();
  homeOrg = TEAM; // the key was minted in the holder's own account
  seedKey(TOKEN, { scopes: ['context:read', 'context:write', 'context:admin'] });
  const res = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(res.body.scopes, ['context:read', 'context:write', 'context:admin']);
});

test('a key with no owning person is left as minted', async () => {
  activeWorkspace = null;
  seedKey(TOKEN, { ownerId: null, orgId: TEAM, scopes: ['context:read', 'context:write'] });
  const res = await request(app).get('/probe').set('Authorization', `Bearer ${TOKEN}`);
  assert.deepStrictEqual(res.body.scopes, ['context:read', 'context:write']);
});

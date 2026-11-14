'use strict';

// The legacy invite pair is retired, not left running beside the real one.
//
//   POST /api/v1/orgs/users        INSERTed a shell `users` row straight into the
//                                  team org and minted a users.invite_token_hash
//                                  link — bypassing workspace_members, seat
//                                  counting and workspaceService entirely.
//   POST /api/v1/auth/invite/accept redeemed that hash. The same column carries
//                                  password-reset tokens, so it was also a second,
//                                  laxer (NULL-expiry) way to spend a reset link.
//
//   DELETE /api/v1/orgs/users/:id  HARD-DELETED the users row — the person, not
//                                  their membership — gated on actor.role, the
//                                  org-level role that is 'admin' by default for
//                                  nearly everyone and is banned as an authority
//                                  precisely because of that.
//
// Workspace membership lives in workspace_members and is created, changed and
// revoked under /api/v1/teams. All three old routes answer 410 Gone and name the
// replacement, so anything external that still calls them learns where to go.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
  req.actor = { id: 'user-owner', org_id: 'org-team', role: 'owner', email: 'owner@acme.test' };
  next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.checkLimit = async () => true;

const db = require('../../src/config/db');
const queries = [];
db.query = async (sql, params) => {
  queries.push({ sql, params });
  return { rows: [], rowCount: 0 };
};

const orgRoutes = require('../../src/routes/shared/orgs');
const authRoutes = require('../../src/routes/shared/auth');

const app = express();
app.use(express.json());
app.use('/api/v1/orgs', orgRoutes);
app.use('/api/v1/auth', authRoutes);

test('POST /api/v1/orgs/users is gone and writes nothing', async () => {
  queries.length = 0;
  const res = await request(app).post('/api/v1/orgs/users').send({ email: 'new@acme.test', role: 'admin' });
  assert.strictEqual(res.status, 410, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'gone');
  assert.match(res.body.message, /POST \/api\/v1\/teams\/invite/);
  assert.ok(!res.body.invite_link, 'no legacy invite link is minted');
  assert.ok(!queries.some((q) => /INSERT INTO users|invite_token_hash/i.test(q.sql)), 'no shell user row, no legacy token');
});

test('POST /api/v1/auth/invite/accept is gone and cannot spend a users.invite_token_hash', async () => {
  queries.length = 0;
  const res = await request(app).post('/api/v1/auth/invite/accept').send({ token: 'abc', password: 'longenough123' });
  assert.strictEqual(res.status, 410, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'gone');
  assert.match(res.body.message, /POST \/api\/v1\/teams\/invite\/accept/);
  assert.ok(!queries.some((q) => /invite_token_hash/i.test(q.sql)), 'the reset-token column is not touched');
});

// Removing somebody must never destroy what they contributed, and it must never
// hinge on users.role. DELETE /api/v1/teams/members/:userId soft-removes the
// membership (removed_at) and revokes their keys, keeping their decisions,
// landmines and paths — the asset the workspace is paying for.
test('DELETE /api/v1/orgs/users/:id is gone and deletes nobody', async () => {
  queries.length = 0;
  const res = await request(app).delete('/api/v1/orgs/users/user-victim');
  assert.strictEqual(res.status, 410, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'gone');
  assert.match(res.body.message, /DELETE \/api\/v1\/teams\/members/);
  assert.ok(!queries.some((q) => /DELETE FROM users/i.test(q.sql)), 'no users row is destroyed');
});

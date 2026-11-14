'use strict';

// Guards for the setup-path defects found in the 2026-09 teams scan: the invite
// email that never left, the device-flow key stamped with the personal org, and
// the billing routes that could only ever upgrade the personal org.
//
// Behavioural where it can be without a database (module stubs, as the sibling
// device-flow suite does); the DB-backed half — activation on accept, the
// signup membership row, the wizard workspace's plan — lives in
// tests/integration/teams-setup-defects.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

let currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: 'org-team', email: 'owner@acme.test' };

// Stub requireAuth BEFORE the routers destructure it at load time.
const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
  req.actor = { ...currentActor };
  next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.checkLimit = async () => true;
entitlements.getEntitlements = async () => ({ limits: {}, features: {} });

const sent = [];
let sendResult = { ok: true };
const resendClient = require('../../src/services/email/resendClient');
resendClient.sendEmail = async (message) => {
  sent.push(message);
  return sendResult;
};

const db = require('../../src/config/db');
const queries = [];
db.query = async (sql, params) => {
  queries.push({ sql, params });
  if (/SELECT name FROM organizations/.test(sql)) return { rows: [{ name: 'Acme <script>alert(1)</script> & Co' }] };
  return { rows: [] };
};

const workspace = require('../../src/services/workspaceService');
const roles = {};
workspace.resolveRole = async (_actor, ownerKey) => roles[ownerKey] || 'viewer';
workspace.countActiveMembers = async () => 1;
workspace.listInvites = async () => [];
workspace.listMembers = async () => [];
workspace.createInvite = async () => ({ token: 'tok123', invite_id: 'inv-1', expires_at: new Date().toISOString() });

const stripeService = require('../../src/services/stripeService');
const checkouts = [];
const portals = [];
stripeService.createCheckoutSession = async (orgId, email, tier, opts) => {
  checkouts.push({ orgId, email, tier, opts });
  return 'https://checkout.stripe.test/session';
};
stripeService.createPortalSession = async (orgId) => {
  portals.push(orgId);
  return 'https://billing.stripe.test/portal';
};

const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async () => ({});
const redisModule = require('../../src/config/redis');

const teamsRouter = require('../../src/routes/shared/teams');
const billingRouter = require('../../src/routes/shared/billing');
const mcpAuthRouter = require('../../src/routes/shared/mcp-auth');

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/teams', teamsRouter);
  app.use('/billing', billingRouter);
  app.use('/auth/mcp', mcpAuthRouter);
  return app;
}

function reset() {
  sent.length = 0;
  queries.length = 0;
  checkouts.length = 0;
  portals.length = 0;
  sendResult = { ok: true };
  for (const key of Object.keys(roles)) delete roles[key];
  currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: 'org-team', email: 'owner@acme.test' };
}

// --- #4 invite emails ------------------------------------------------------

test('an invitation is sent through Resend and reports email_sent', async () => {
  reset();
  roles['org-team'] = 'owner';
  const res = await request(appWith()).post('/teams/invite').send({ email: 'New@Acme.test', role: 'member' });

  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.email_sent, true);
  assert.match(res.body.invite_link, /\/invite\?token=tok123$/);
  assert.strictEqual(sent.length, 1, 'exactly one email');
  assert.strictEqual(sent[0].to, 'new@acme.test');
  assert.strictEqual(sent[0].emailType, 'team_invite');
  assert.ok(sent[0].html.includes('/invite?token=tok123'), 'the email must carry the link');
});

test('the workspace and inviter names are escaped in the email body', async () => {
  reset();
  roles['org-team'] = 'owner';
  currentActor.email = 'mallory"><img src=x>@acme.test';
  await request(appWith()).post('/teams/invite').send({ email: 'new@acme.test' });

  const { html } = sent[0];
  assert.ok(!html.includes('<script>'), 'a workspace name is user input and must not render as markup');
  assert.ok(html.includes('Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
  assert.ok(!html.includes('<img src=x>'), 'the inviter is user input too');
});

test('an unsent invitation says so instead of claiming success', async () => {
  reset();
  roles['org-team'] = 'owner';
  const saved = { a: process.env.TEAM_INVITE_EMAIL_WEBHOOK_URL, b: process.env.RESET_EMAIL_WEBHOOK_URL };
  delete process.env.TEAM_INVITE_EMAIL_WEBHOOK_URL;
  delete process.env.RESET_EMAIL_WEBHOOK_URL;
  try {
    sendResult = { skipped: true, reason: 'no_api_key' };
    const skipped = await request(appWith()).post('/teams/invite').send({ email: 'a@acme.test' });
    assert.strictEqual(skipped.status, 201);
    assert.strictEqual(skipped.body.email_sent, false, 'no API key means nobody was emailed');
    assert.ok(skipped.body.invite_link, 'the link is the fallback and must still be returned');

    sendResult = { ok: false, status: 422 };
    const failed = await request(appWith()).post('/teams/invite').send({ email: 'b@acme.test' });
    assert.strictEqual(failed.body.email_sent, false);
  } finally {
    if (saved.a !== undefined) process.env.TEAM_INVITE_EMAIL_WEBHOOK_URL = saved.a;
    if (saved.b !== undefined) process.env.RESET_EMAIL_WEBHOOK_URL = saved.b;
  }
});

// --- #7 a wizard workspace starts on Free, and billing targets the bound workspace

// Journey r6 (owner's decision): a team workspace is created at checkout, not
// before. This used to pin that the wizard's workspace was written as Free with no
// inherited plan; nothing is written now, so there is no plan to inherit (the
// webhook that creates it grants exactly what Stripe bills: see
// integration/journey-r6-workspace-at-checkout.test.js).
test('creating a workspace writes nothing: it is created when its Team subscription is confirmed', async () => {
  reset();
  workspace.addMember = async () => { throw new Error('no membership is written before payment'); };
  const res = await request(appWith()).post('/teams/workspaces').send({ name: 'Acme' });

  assert.strictEqual(res.status, 402, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'checkout_required');
  assert.strictEqual(res.body.created, false);
  assert.ok(!queries.find((q) => /INSERT INTO organizations/.test(q.sql)),
    'no organization row may be written before the subscription is confirmed');
});

test('checkout buys the plan for the BOUND workspace, and only an owner may', async () => {
  reset();
  roles['org-team'] = 'owner';
  const ok = await request(appWith()).post('/billing/checkout').send({ tierId: 'developer_pro', seats: 3 });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(checkouts.length, 1);
  assert.strictEqual(checkouts[0].orgId, 'org-team', 'checkout must never quietly upgrade the personal org');

  reset();
  roles['org-team'] = 'member';
  const refused = await request(appWith()).post('/billing/checkout').send({ tierId: 'developer_pro' });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(checkouts.length, 0, 'a member must not be able to buy a plan for the team');
});

test('the billing portal and downgrade are owner-only on the bound workspace', async () => {
  reset();
  roles['org-team'] = 'owner';
  const portal = await request(appWith()).post('/billing/portal').send({});
  assert.strictEqual(portal.status, 200, JSON.stringify(portal.body));
  assert.deepStrictEqual(portals, ['org-team']);

  reset();
  roles['org-team'] = 'viewer';
  assert.strictEqual((await request(appWith()).post('/billing/portal').send({})).status, 403);
  assert.strictEqual((await request(appWith()).post('/billing/downgrade').send({})).status, 403);
  assert.strictEqual(portals.length, 0);
});

// --- #13 device-flow key ---------------------------------------------------

test('a device-flow key is stamped with the bound workspace and capped at the role', async () => {
  reset();
  roles['org-team'] = 'viewer';
  const store = {
    'mcp:user:6FC02C66': 'devicecode123',
    'mcp:device:devicecode123': JSON.stringify({ status: 'pending', user_code: '6FC02C66' }),
  };
  const original = { get: redisModule.redis.get, set: redisModule.redis.set, ttl: redisModule.redis.ttl };
  redisModule.redis.get = async (key) => store[key] || null;
  redisModule.redis.set = async (key, value) => { store[key] = value; return 'OK'; };
  redisModule.redis.ttl = async () => 300;
  try {
    const res = await request(appWith()).post('/auth/mcp/authorize').send({ user_code: '6FC02C66' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const insert = queries.find((q) => /INSERT INTO api_keys/.test(q.sql));
    assert.ok(insert, 'a key must be minted');
    const [, , , , ownerId, orgId, , , scopes] = insert.params;
    assert.strictEqual(ownerId, 'user-owner');
    assert.strictEqual(orgId, 'org-team', 'the key belongs to the workspace being worked in');
    assert.deepStrictEqual(scopes, ['context:read'], 'a viewer must not mint a write key');
  } finally {
    Object.assign(redisModule.redis, original);
  }
});

// --- #6 / #15 source guards --------------------------------------------------

const SRC = path.resolve(__dirname, '..', '..', 'src');
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (...rel) => stripComments(fs.readFileSync(path.join(SRC, ...rel), 'utf8'));

test('every signup path writes the founder\'s membership row', () => {
  // The boot backfill used to be the only writer, so anyone who signed up between
  // deploys was missing from their own roster.
  const passwordSignup = read('routes', 'shared', 'auth.js');
  const insertAt = passwordSignup.indexOf('INSERT INTO users (user_id, email, password_hash, role, org_id)');
  assert.ok(insertAt > -1);
  assert.ok(/ensureOwnerMembership\(orgId, userId\)/.test(passwordSignup.slice(insertAt, insertAt + 800)),
    'password signup must write the owner membership right after the user row');

  const webhook = read('routes', 'auth-webhooks.js');
  assert.ok(/ensureOwnerMembership\(orgId, userId\)/.test(webhook), 'the Clerk webhook must write it');

  const jit = read('middleware', 'auth.js');
  const sync = jit.slice(jit.indexOf('async syncUser'), jit.indexOf('_resolveRoleForProvider(provider) {'));
  assert.strictEqual((sync.match(/INSERT INTO organizations/g) || []).length, 3);
  assert.strictEqual((sync.match(/ensureFounderMembership\(/g) || []).length, 3,
    'each of the three org-minting branches of Clerk JIT provisioning must write it');
});

test('plan gating and the dashboard plan badge follow the bound workspace', () => {
  const enforce = read('middleware', 'enforcePlan.js');
  assert.ok(!/const orgId = actor\.org_id/.test(enforce));
  assert.ok(/workspace\.defaultOwnerKey\(actor\)/.test(enforce));

  const dashboard = read('routes', 'shared', 'dashboard.js');
  assert.ok(!/const orgId = req\.actor\.org_id/.test(dashboard));

  const billing = read('routes', 'shared', 'billing.js');
  assert.ok(!/req\.actor\.org_id\s*;/.test(billing), 'billing must target the bound workspace');
});

'use strict';

// "Delete my account" emailed the caller the TEAM's brain.
//
// The deletion route offers a data-portability courtesy on the way out: tick
// email_export and it sends a full markdown export of your profile, projects and
// knowledge graph before the purge. exportContext resolves its owner through
// workspaceService.defaultOwnerKey, which reads `actor.workspace_key` FIRST — and
// the auth middleware binds that on EVERY request, from the x-deerdawn-workspace
// header or, with no header at all, from the person's active workspace
// (getActiveWorkspace; activateJoinedWorkspace sets it the moment they accept
// their first invite).
//
// So an invited teammate deleting their own account was emailed the whole team
// workspace, while the purge underneath erased only their own org. No header, no
// flag, no privilege: join a team, delete your account, receive its brain by
// email. The export has to describe exactly what is about to be destroyed.
//
// The authorization gates were the second half. `req.actor.role` is the ORG-level
// role on the users row — 'admin' by default for nearly every self-signup — so it
// separated almost nobody from anybody. Survivable only while users.org_id is
// always a personal org, and the legacy invite path in routes/shared/orgs.js
// creates users directly INSIDE the target org. For that population orgId IS the
// team, and this route deletes the organizations row, every user in it, and every
// Clerk identity attached. Now gated on the WORKSPACE role, and refused outright
// while the workspace still holds anybody else — the same two gates
// DELETE /api/v1/context/account already carries.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const TEAM = 'org-team-acme';
const PERSONAL = 'org-personal-dana';

// requireAuth is destructured into orgs.js at require time, so it is replaced on
// the module object BEFORE the router is loaded.
const auth = require('../../src/middleware/auth');
let actor = null;
auth.requireAuth = (req, _res, next) => { req.actor = { ...actor }; next(); };
auth.isClerkConfigured = () => false;
auth.deleteClerkUser = async () => {};

const db = require('../../src/config/db');
db.query = async (text) => {
  if (/FROM users WHERE user_id/.test(text)) {
    return { rows: [{ user_id: 'user-dana', email: 'dana@example.com', auth_provider: 'local', auth_subject: null, password_hash: null }] };
  }
  return { rows: [] };
};
const purged = [];
db.pool = {
  connect: async () => ({
    query: async (text, params) => {
      if (/DELETE FROM organizations/.test(text)) { purged.push(params[0]); return { rowCount: 1 }; }
      return { rowCount: 0 };
    },
    release: () => {},
  }),
};

const stripe = require('../../src/services/stripeService');
stripe.cancelSubscriptionForDeletion = async () => ({ ok: true, cancelled: false });

const erasure = require('../../src/services/dataErasureService');
const erased = [];
erasure.purgeOwnerData = async (ownerKey) => { erased.push(ownerKey); return {}; };

const contextSync = require('../../src/services/contextSyncService');
const exportedFor = [];
contextSync.exportContext = async (exportActor) => {
  // The same resolution the real exportContext does.
  const key = exportActor?.workspace_key || exportActor?.org_id || exportActor?.id;
  exportedFor.push(key);
  return {
    exported_at: new Date().toISOString(),
    schema_version: 1,
    owner_key: key,
    global_context: {},
    preferences: {},
    projects: key === TEAM
      ? [{ project_id: 'p-team', project_name: 'Acme Q1 acquisition', context: {}, graph: { nodes: [], edges: [] } }]
      : [{ project_id: 'p-dana', project_name: 'Dana side project', context: {}, graph: { nodes: [], edges: [] } }],
  };
};

const resend = require('../../src/services/email/resendClient');
const sent = [];
resend.sendEmail = async (message) => { sent.push(message); return { ok: true }; };

const workspace = require('../../src/services/workspaceService');
const realResolveRole = workspace.resolveRole;
const realIsSharedWorkspace = workspace.isSharedWorkspace;
let workspaceRole = 'owner';
let shared = false;
workspace.resolveRole = async () => workspaceRole;
workspace.isSharedWorkspace = async () => shared;

const app = express();
app.use(express.json());
app.use('/api/v1/orgs', require('../../src/routes/shared/orgs'));
const httpServer = app.listen(0);
const del = (body) => request(httpServer).delete('/api/v1/orgs/').send(body);

beforeEach(() => {
  purged.length = 0; erased.length = 0; exportedFor.length = 0; sent.length = 0;
  workspaceRole = 'owner';
  shared = false;
  // Dana is signed in with the TEAM workspace bound — the default state for
  // anybody who has ever accepted an invite, with or without a header.
  actor = { type: 'user', id: 'user-dana', org_id: PERSONAL, workspace_key: TEAM, role: 'admin', scopes: ['context:admin'] };
});

test('the export describes the account being deleted, not the workspace bound to the session', async () => {
  const res = await del({ confirm_email: 'dana@example.com', email_export: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  assert.deepStrictEqual(exportedFor, [PERSONAL], 'the export is scoped to the org being purged');
  assert.deepStrictEqual(erased, [PERSONAL], 'and that is the same key the purge was given');
  assert.deepStrictEqual(purged, [PERSONAL]);

  const attachment = Buffer.from(sent[0].attachments[0].content, 'base64').toString('utf-8');
  assert.ok(attachment.includes('Dana side project'), 'her own work is in the export');
  assert.ok(!attachment.includes('Acme Q1 acquisition'), 'the team\'s work is not');
});

test('deleting is gated on the WORKSPACE role, not the org role every signup carries', async () => {
  // Dana's users.org_id IS the team, the legacy-invite shape. Her org role is
  // 'admin' like nearly everyone's; her workspace role is not.
  actor = { ...actor, org_id: TEAM, workspace_key: TEAM, role: 'admin' };
  workspaceRole = 'member';
  const res = await del({ confirm_email: 'dana@example.com' });
  assert.strictEqual(res.status, 403, 'a member cannot delete the workspace she was invited into');
  assert.deepStrictEqual(purged, [], 'nothing was deleted');
  assert.deepStrictEqual(erased, []);
});

test('a workspace holding other people is refused, even to its owner', async () => {
  actor = { ...actor, org_id: TEAM, workspace_key: TEAM };
  workspaceRole = 'owner';
  shared = true;
  const res = await del({ confirm_email: 'dana@example.com', email_export: true });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'workspace_has_members');
  assert.deepStrictEqual(purged, [], 'a shared workspace is not destroyed as a side effect of one person leaving');
  assert.deepStrictEqual(exportedFor, [], 'and nothing was exported on the way');
});

test('a solo account still deletes, and still gets its export', async () => {
  actor = { type: 'user', id: 'user-dana', org_id: PERSONAL, workspace_key: PERSONAL, role: 'owner', scopes: ['context:admin'] };
  const res = await del({ confirm_email: 'dana@example.com', email_export: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.export_emailed, true);
  assert.deepStrictEqual(exportedFor, [PERSONAL]);
  assert.deepStrictEqual(purged, [PERSONAL]);
});

// The gate's own failure mode, checked against the REAL resolveRole rather than
// the stub: a new gate that refuses everybody is not a safer gate. Most accounts
// have no workspace_members row at all — resolveRole falls through to the org role
// for somebody in their OWN workspace precisely so the membership backfill cannot
// lock people out of their own account, and account deletion has to survive that
// path or this fix breaks deletion for nearly every customer.
test('a solo account with no membership row is still allowed to delete', async () => {
  workspace.resolveRole = realResolveRole;
  workspace.isSharedWorkspace = realIsSharedWorkspace;
  try {
    // db.query answers no rows for the membership and headcount lookups.
    actor = { type: 'user', id: 'user-dana', org_id: PERSONAL, workspace_key: PERSONAL, role: 'owner', scopes: ['context:admin'] };
    const res = await del({ confirm_email: 'dana@example.com', email_export: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(purged, [PERSONAL]);
    assert.deepStrictEqual(exportedFor, [PERSONAL]);
  } finally {
    workspace.resolveRole = async () => workspaceRole;
    workspace.isSharedWorkspace = async () => shared;
  }
});

test.after(() => new Promise((resolve) => httpServer.close(resolve)));

'use strict';

/**
 * WHAT A LAPSED TEAM SAYS, AND TO WHOM.
 *
 * Three separate sentences, each true of a narrower case than the one it was
 * being said about:
 *
 *  1. otherWorkspaceNotice fired on every start_session for a teammate on the
 *     INTENDED path — the key was minted FOR the team, and every invited person
 *     is also a member of their own personal org, so the notice listed that
 *     personal org as somewhere they were "also a member of" and told them to
 *     use "the team's .mcp.json" to reach it.
 *  2. The fallback WRITE notice keyed on TOOL_SCOPES, which is per tool, so
 *     `manage_tasks {action:"list"}` claimed a listing had been saved somewhere.
 *  3. The 409 told the OWNER of the lapsed team to go and ask a workspace owner
 *     to update billing.
 *
 * And the 409 itself refused writes that never addressed the lapsed workspace.
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const PERSONAL = 'org-personal-notice';
const TEAM = 'org-team-notice';
const PERSON = 'user-notice';

// ---------------------------------------------------------------------------
// 1 + 2: the two notices routes/mcp.js writes
// ---------------------------------------------------------------------------

const orgs = new Map([[PERSONAL, 'Personal'], [TEAM, 'Acme Engineering']]);
const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/FROM users WHERE user_id/.test(text)) return { rows: [{ org_id: PERSONAL }] };
  if (/FROM organizations WHERE org_id = ANY/.test(text)) {
    return { rows: (params[0] || []).map((id) => ({ org_id: id, name: orgs.get(id) || id })) };
  }
  if (/FROM organizations WHERE org_id = \$1/.test(text)) {
    const name = orgs.get(params[0]);
    return { rows: name ? [{ name }] : [] };
  }
  return { rows: [] };
};

const mcp = require('../../src/routes/mcp');
const { otherWorkspaceNotice, callWrites } = mcp.__testables;

const BOTH = [{ owner_key: PERSONAL, role: 'owner' }, { owner_key: TEAM, role: 'member' }];

test('a key minted FOR the team says nothing at all', async () => {
  // The intended path. org_id is the team because that is where the key was
  // minted, which is exactly why actor.org_id cannot stand in for "personal".
  const notice = await otherWorkspaceNotice({
    type: 'key',
    id: 'key-1',
    owner_id: PERSON,
    org_id: TEAM,
    workspace_key: TEAM,
    workspace_memberships: BOTH,
  });
  assert.equal(notice, null, 'THE BUG: this fired forever, about the person\'s own personal workspace');
});

test('a key that predates the invitation says so, and names the team', async () => {
  const notice = await otherWorkspaceNotice({
    type: 'key',
    id: 'key-2',
    owner_id: PERSON,
    org_id: PERSONAL,
    workspace_key: PERSONAL,
    workspace_memberships: BOTH,
  });
  assert.ok(notice, 'this is the case the notice exists for');
  assert.match(notice, /Acme Engineering/, 'the team is named');
  assert.doesNotMatch(notice, /Personal/, 'the personal workspace is never listed as somewhere they are "also a member"');
  assert.match(notice, /personal workspace/, 'and the wording is about the direction it is actually in');
});

test('a solo account pays for no lookup and hears nothing', async () => {
  const notice = await otherWorkspaceNotice({
    type: 'key',
    id: 'key-3',
    owner_id: PERSON,
    org_id: PERSONAL,
    workspace_key: PERSONAL,
    workspace_memberships: [{ owner_key: PERSONAL, role: 'owner' }],
  });
  assert.equal(notice, null);
});

test('an OAuth token follows the switcher and is never told to edit a file', async () => {
  const notice = await otherWorkspaceNotice({
    type: 'key',
    id: 'key-4',
    owner_id: PERSON,
    org_id: PERSONAL,
    workspace_key: PERSONAL,
    oauth_resource: 'https://api.deerdawn.com/mcp',
    workspace_memberships: BOTH,
  });
  assert.equal(notice, null);
});

test('the fallback notice is chosen per ACTION, not per tool', () => {
  // A listing saves nothing, whatever its tool's scope says.
  assert.equal(callWrites('manage_tasks', { action: 'list' }), false);
  assert.equal(callWrites('manage_todos', { action: 'list' }), false);
  // An omitted action is a real call shape, and these two default differently.
  assert.equal(callWrites('manage_tasks', {}), false, 'manage_tasks defaults to list');
  assert.equal(callWrites('manage_memory', {}), true, 'manage_memory defaults to update');

  for (const action of ['add', 'move', 'complete', 'remove']) {
    assert.equal(callWrites('manage_tasks', { action }), true, `${action} writes`);
  }
  assert.equal(callWrites('manage_memory', { action: 'export_trail' }), false, 'an export reads');
  assert.equal(callWrites('manage_memory', { action: 'import_trail' }), true);
  assert.equal(callWrites('update_context', {}), true, 'an ungrouped write tool is unaffected');
  assert.equal(callWrites('recall', { action: 'context' }), false, 'a read-scoped tool never writes');
});

// ---------------------------------------------------------------------------
// 3: which writes the 409 may refuse, and how it reads
// ---------------------------------------------------------------------------

const workspace = require('../../src/services/workspaceService');
const auth = require('../../src/middleware/auth');
const { mayBeServedByFallback, refuseWriteToInactiveWorkspace } = auth.__testables;

const req = (method, url) => ({ method, originalUrl: url });

test('a write aimed somewhere other than the lapsed workspace is not refused', () => {
  // Joining a DIFFERENT, healthy team: the write targets the invite's
  // workspace, resolved from the token.
  assert.equal(mayBeServedByFallback(req('POST', '/api/v1/teams/invite/accept')), true);
  // Creating a new workspace touches nothing bound.
  assert.equal(mayBeServedByFallback(req('POST', '/api/v1/teams/workspaces')), true);
  // Deleting your own account, as before.
  assert.equal(mayBeServedByFallback(req('DELETE', '/api/v1/context/account')), true);
});

test('a write that WOULD land in the wrong workspace is still refused', () => {
  // Preferences are stored per workspace (store.savePreferences takes the owner
  // key), so this is exactly the misplacement the 409 exists to stop.
  assert.equal(mayBeServedByFallback(req('PATCH', '/api/v1/context/preferences')), false);
  assert.equal(mayBeServedByFallback(req('POST', '/api/v1/context/projects')), false);
  assert.equal(mayBeServedByFallback(req('POST', '/api/v1/teams/invite')), false, 'sending one is not accepting one');
});

test('the owner of the lapsed team is told to update billing, not to go find herself', async () => {
  workspace.resolveRole = async () => 'owner';
  const refusal = await refuseWriteToInactiveWorkspace({ from: TEAM }, { id: PERSON });
  assert.equal(refusal.status, 409);
  assert.match(refusal.body.message, /Update billing to keep working in Acme Engineering/);
  assert.doesNotMatch(
    refusal.body.message,
    /ask a workspace owner/,
    'THE BUG: the one person who can pay was sent to find somebody who could',
  );
});

test('a member still gets the sentence a member can act on', async () => {
  workspace.resolveRole = async () => 'member';
  const refusal = await refuseWriteToInactiveWorkspace({ from: TEAM }, { id: PERSON });
  assert.match(refusal.body.message, /ask a workspace owner to update billing/);
});

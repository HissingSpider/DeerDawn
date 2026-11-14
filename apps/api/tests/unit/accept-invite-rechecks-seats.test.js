'use strict';

/**
 * AN INVITATION IS NOT A STANDING GRANT.
 *
 * POST /teams/invite enforces the plan feature and the seat cap when the
 * invitation is SENT. Nothing re-asked when it was redeemed, and the default
 * invite lives for a week — long enough for the card to fail and for
 * `customer.subscription.deleted` to write the workspace back to plan free. A
 * pending invitation accepted after that added a third active member to a free
 * workspace: the seat was never sold, and the gate that would have refused it
 * had already run days earlier.
 *
 * Only the ACCEPT is changed here. What existing members of a cancelled team
 * may do is a product decision and is raised in the PR, not decided in code.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/accept-invite-rechecks-seats.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const entitlements = require('../../src/services/entitlementService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const TEAM = `org-${crypto.randomUUID()}`;
const OWNER = `user-owner-${RUN}`;
const INVITEE = `user-invitee-${RUN}`;
const INVITEE_EMAIL = `invitee-${RUN}@acme.test`;

// The workspace's entitlements as the webhook would have left them. Stubbed at
// checkFeature/checkLimit rather than at getEntitlements, because those two call
// it through a local binding: acceptInvite requires this module at call time, so
// replacing the exports is what actually reaches it.
let plan = { team_management: true, included_seats: 5 };
const realCheckFeature = entitlements.checkFeature;
const realCheckLimit = entitlements.checkLimit;
entitlements.checkFeature = async (_orgId, feature) => {
  if (plan[feature]) return true;
  throw { status: 402, code: 'upgrade_required', message: `${feature} is not available on this plan.` };
};
entitlements.checkLimit = async (_orgId, limitName, currentCount) => {
  const limit = plan[limitName];
  if (Number.isFinite(limit) && currentCount >= limit) {
    throw { status: 402, code: 'limit_exceeded', message: `You have reached the limit for ${limitName}.` };
  }
  return true;
};

test.before(async () => {
  await db.query(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, $2, 'team', 'team', 'active', 'organization')`,
    [TEAM, 'Acme Engineering'],
    'org-system',
  );
  await workspace.addMember(TEAM, OWNER, { role: 'owner' });
});

test.after(async () => {
  entitlements.checkFeature = realCheckFeature;
  entitlements.checkLimit = realCheckLimit;
  await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [TEAM], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [TEAM], 'org-system').catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [TEAM], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

const invite = async (email) => workspace.createInvite(TEAM, email, { role: 'member', invitedBy: OWNER });

test.beforeEach(async () => {
  plan = { team_management: true, included_seats: 5 };
  await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [TEAM], 'org-system');
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1 AND user_id <> $2', [TEAM, OWNER], 'org-system');
});

test('an invitation sent while paying still works while paying', async () => {
  const sent = await invite(INVITEE_EMAIL);
  const result = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.ok, true, 'the ordinary path is untouched');
  assert.equal(result.owner_key, TEAM);
});

test('an invitation accepted AFTER the subscription was cancelled is refused', async () => {
  const sent = await invite(INVITEE_EMAIL);
  // What the webhook leaves behind: plan free, so team_management is off.
  plan = { team_management: false, included_seats: 1 };

  const result = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.ok, false, 'THE BUG: a free workspace grew a third member through a stale link');
  assert.equal(result.reason, 'workspace_not_accepting_members');
  assert.match(result.message, /Acme Engineering is not accepting new members right now/);
  assert.match(result.message, /Ask the person who invited you/);

  const members = await workspace.listMembers(TEAM);
  assert.deepEqual(members.map((m) => m.user_id), [OWNER], 'nobody was added');
});

test('a refusal leaves the invitation pending, so paying again makes the link work', async () => {
  const sent = await invite(INVITEE_EMAIL);
  plan = { team_management: false, included_seats: 1 };
  assert.equal((await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL })).ok, false);

  const pending = await workspace.listInvites(TEAM);
  assert.equal(pending.length, 1, 'the invitation is not consumed by a billing refusal');

  plan = { team_management: true, included_seats: 5 };
  const second = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(second.ok, true, 'the same link works once the workspace is paid for again');
});

test('the seat cap is re-checked too, against the active members', async () => {
  // One seat, one active member (the owner): the seat is already spent.
  plan = { team_management: true, included_seats: 1 };
  const sent = await invite(INVITEE_EMAIL);

  const result = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_not_accepting_members');
});

test('the invitation that fills the LAST seat is accepted: it is not a second seat', async () => {
  // The default team: two seats, the owner, and the first person she invites.
  // The invitation was counted against the cap when it was sent. Counting it
  // again at accept, beside the membership it is about to become, refused
  // exactly this person: every new team's first teammate.
  plan = { team_management: true, included_seats: 2 };
  const sent = await invite(INVITEE_EMAIL);

  const result = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.ok, true, 'THE BUG: the seat held for this person was refused to them');
  const members = await workspace.listMembers(TEAM);
  assert.equal(members.length, 2);
});

test('a full cap of invitations can all be redeemed, in any order', async () => {
  plan = { team_management: true, included_seats: 3 };
  const first = await invite(INVITEE_EMAIL);
  const secondEmail = `second-${RUN}@acme.test`;
  const second = await invite(secondEmail);

  assert.equal((await workspace.acceptInvite(second.token, { id: `user-second-${RUN}`, email: secondEmail })).ok, true);
  const last = await workspace.acceptInvite(first.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(last.ok, true, 'whoever redeems last still has the seat that was held for them');
  assert.equal((await workspace.listMembers(TEAM)).length, 3);
});

test('seats removed after the invitation was sent: the free seat goes to whoever accepts first, never past the cap', async () => {
  // Two invitations went out against three seats; the owner then dropped to two.
  plan = { team_management: true, included_seats: 3 };
  const first = await invite(INVITEE_EMAIL);
  const secondEmail = `second-${RUN}@acme.test`;
  const second = await invite(secondEmail);
  plan = { team_management: true, included_seats: 2 };

  // Pending invitations are reservations, not occupancy. Counting the OTHER
  // one here (owner 1 + pending 1 = the cap) refused BOTH invitees while a seat
  // stood empty (scan 14). One active member, two seats: this one gets in.
  const result = await workspace.acceptInvite(first.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.ok, true, 'the free seat was refused because of somebody else\'s reservation');
  // And now the team is full: the other invitee is refused, not admitted past it.
  const late = await workspace.acceptInvite(second.token, { id: `user-second-${RUN}`, email: secondEmail });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'workspace_not_accepting_members');
  assert.equal((await workspace.listMembers(TEAM)).length, 2);
});

test('joining a healthy team moves you out of a LAPSED one, and never out of a live one', async () => {
  // Somebody whose active team stopped paying is already being served from
  // their personal workspace on every request. Accepting an invitation to a
  // healthy team left the lapsed one active, so their tools kept opening with
  // "this team's subscription is inactive" and an MCP-only client has no
  // switcher to leave with.
  // Two other teams rather than one whose status is flipped: enforcement reads
  // the org through a cache, so the same row set to 'active' a moment later is
  // still answered as past_due, and the control would test the cache instead.
  const LAPSED = `org-${crypto.randomUUID()}`;
  const LIVE = `org-${crypto.randomUUID()}`;
  const actor = { id: INVITEE, org_id: null };
  // 'developer_pro' IS Team. An unknown tier such as 'team' resolves to Free, and
  // Free with an inactive status is deliberately not a lockout, so a fixture
  // spelled that way can never be lapsed and this test would prove nothing.
  const seed = (orgId, status) => db.query(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, 'Other Team', 'developer_pro', 'developer_pro', $2, 'organization')`,
    [orgId, status],
    'org-system',
  );
  try {
    await seed(LAPSED, 'past_due');
    await seed(LIVE, 'active');
    await workspace.addMember(LAPSED, INVITEE, { role: 'member' });
    await workspace.addMember(LIVE, INVITEE, { role: 'member' });

    await workspace.setActiveWorkspace(actor, LAPSED);
    const sent = await invite(INVITEE_EMAIL);
    const joined = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
    assert.equal(joined.ok, true);
    assert.equal(await workspace.getActiveWorkspace(actor), TEAM, 'THE BUG: still parked in the lapsed team');

    // The control: a LIVE team the person chose is never redirected.
    await workspace.setActiveWorkspace(actor, LIVE);
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [TEAM, INVITEE], 'org-system');
    const again = await invite(INVITEE_EMAIL);
    assert.equal((await workspace.acceptInvite(again.token, { id: INVITEE, email: INVITEE_EMAIL })).ok, true);
    assert.equal(await workspace.getActiveWorkspace(actor), LIVE, 'a second invite must not redirect a live agent loop');
  } finally {
    for (const orgId of [LAPSED, LIVE]) {
      await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
      await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    }
  }
});

test('an expired or revoked link still reports what it actually is', async () => {
  // The new check must not swallow the three failures that already had names.
  const sent = await invite(INVITEE_EMAIL);
  await workspace.revokeInvite(TEAM, sent.invite_id);
  const result = await workspace.acceptInvite(sent.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(result.reason, 'revoked');

  const other = await invite(`someone-else-${RUN}@acme.test`);
  const wrong = await workspace.acceptInvite(other.token, { id: INVITEE, email: INVITEE_EMAIL });
  assert.equal(wrong.reason, 'wrong_account');
});

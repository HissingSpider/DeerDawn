const test = require('node:test');
const assert = require('node:assert/strict');

const now = new Date('2026-05-20T12:00:00.000Z');
const realDateNow = Date.now;
Date.now = () => now.getTime();

const updates = [];

// Whether the referrer has a first_sync_completed event. Flipped per test.
let referrerActivated = true;

// How much of the programme the referrer has already been given. Flipped per
// test to stand the account at, or below, the cap.
let referrerGrants = { granted: 0, rewarded: 0 };

const mockDb = {
  query: async (text, params) => {
    if (text.includes('event_name = \'first_sync_completed\'')) {
      return { rows: [{ activated: referrerActivated }] };
    }

    if (text.includes('COUNT(*) FILTER') && text.includes('FROM referrals')) {
      return { rows: [{ granted: referrerGrants.granted, rewarded: referrerGrants.rewarded }] };
    }

    if (text.includes('SELECT referral_code FROM users')) {
      return { rows: [{ referral_code: null }] };
    }

    if (text.includes('UPDATE users SET referral_code')) {
      updates.push({ kind: 'user_code', params });
      return { rows: [{ referral_code: params[0] }] };
    }

    if (text.includes('SELECT u.user_id, u.org_id, u.email')) {
      return {
        rows: [{
          user_id: 'user-referrer',
          org_id: 'org-referrer',
          email: 'referrer@example.com',
          referral_code: 'SHARE123',
        }],
      };
    }

    if (text.includes('INSERT INTO referrals')) {
      updates.push({ kind: 'referral_insert', params });
      return { rowCount: 1, rows: [{ referral_id: params[0] }] };
    }

    if (text.includes('SELECT referral_id, referral_code, referrer_user_id')) {
      return { rows: [] };
    }

    if (text.includes('SELECT referral_id, referrer_user_id, referrer_org_id')) {
      return {
        rows: [{
          referral_id: 'ref-1',
          referrer_user_id: 'user-referrer',
          referrer_org_id: 'org-referrer',
          referred_user_id: 'user-referred',
          referred_org_id: 'org-referred',
          referral_code: 'SHARE123',
          status: 'signed_up',
        }],
      };
    }

    if (text.includes('UPDATE organizations') && text.includes('referral_premium_until')) {
      updates.push({ kind: 'org_reward', params });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes('UPDATE referrals')) {
      updates.push({ kind: 'referral_update', params });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes('SELECT plan_tier, subscription_status, referral_premium_until')) {
      return {
        rows: [{
          plan_tier: 'free',
          subscription_status: 'trial_active',
          referral_premium_until: '2026-06-03T12:00:00.000Z',
        }],
      };
    }

    throw new Error(`Unexpected query: ${text}`);
  },
};

require.cache[require.resolve('../../src/config/db')] = {
  exports: mockDb,
};

const referralService = require('../../src/services/referralService');
const entitlementService = require('../../src/services/entitlementService');

test('ensureReferralCode creates a share code and signup attribution stores a pending referral', async () => {
  const code = await referralService.ensureReferralCode({
    id: 'user-referrer',
    org_id: 'org-referrer',
    email: 'referrer@example.com',
  });

  assert.match(code, /^[A-Z0-9]{8}$/);

  await referralService.recordReferralSignup({
    referredUserId: 'user-referred',
    referredOrgId: 'org-referred',
    referralCode: 'SHARE123',
    source: 'signup',
  });

  assert.ok(updates.some((entry) => entry.kind === 'user_code'));
  assert.ok(updates.some((entry) => entry.kind === 'referral_insert'));
});

test('the referred account gets its Pro month at signup, before it has done anything', async () => {
  updates.length = 0;
  referrerActivated = true;
  const result = await referralService.recordReferralSignup({
    referredUserId: 'user-referred',
    referredOrgId: 'org-referred',
    referralCode: 'SHARE123',
    source: 'signup',
  });
  assert.ok(result);
  const rewards = updates.filter((entry) => entry.kind === 'org_reward');
  assert.equal(rewards.length, 1, 'exactly one grant at signup: the referred side');
  assert.equal(rewards[0].params[0], 'org-referred');
});

test('an invite from an account that never activated attributes nothing and pays nobody', async () => {
  updates.length = 0;
  referrerActivated = false;
  const result = await referralService.recordReferralSignup({
    referredUserId: 'user-referred-2',
    referredOrgId: 'org-referred-2',
    referralCode: 'SHARE123',
    source: 'signup',
  });
  assert.equal(result, null);
  assert.equal(updates.filter((entry) => entry.kind === 'referral_insert').length, 0);
  assert.equal(updates.filter((entry) => entry.kind === 'org_reward').length, 0);

  const overview = await referralService.listReferralOverview({ id: 'user-never-synced', org_id: 'org-x' });
  assert.equal(overview.eligible, false);
  assert.equal(overview.referral_code, null, 'no invite link is handed out before activation');
  referrerActivated = true;
});

test('the referrer is paid once, on the referred person\'s first sync, and only for that reason', async () => {
  updates.length = 0;
  assert.equal(await referralService.activateReferralForActor({ id: 'user-referred', org_id: 'org-referred' }, 'session_started'), false,
    'the old weak triggers (session_started, project_created, dashboard load) pay nothing');
  assert.equal(updates.length, 0);

  const activated = await referralService.activateReferralForActor({ id: 'user-referred', org_id: 'org-referred' }, 'first_sync');
  assert.equal(activated, true);
  const rewards = updates.filter((entry) => entry.kind === 'org_reward');
  assert.equal(rewards.length, 1, 'only the referrer is granted here; the referred side was paid at signup');
  assert.equal(rewards[0].params[0], 'org-referrer');
  assert.ok(updates.some((entry) => entry.kind === 'referral_update'));
});

// --- Abuse ceilings ---------------------------------------------------------
// Two rules, one attack: a person with a throwaway mailbox minting puppets.
// Without the cap the stacking grant is unbounded; without the signup-only rule
// a code can be attached to accounts that already exist, so the puppets need
// not even be created from the link.

test('an invite code applied AFTER signup is refused, whatever the caller claims', async () => {
  updates.length = 0;
  referrerGrants = { granted: 0, rewarded: 0 };

  for (const source of [undefined, '', 'account_type', 'dashboard', 'signup ']) {
    const result = await referralService.recordReferralSignup({
      referredUserId: 'user-late',
      referredOrgId: 'org-late',
      referralCode: 'SHARE123',
      source,
    });
    assert.equal(result, null, `source "${String(source)}" must not attribute a referral`);
  }

  assert.equal(updates.filter((entry) => entry.kind === 'referral_insert').length, 0);
  assert.equal(updates.filter((entry) => entry.kind === 'org_reward').length, 0,
    'a code applied after the fact grants nobody anything');
});

test('both signup moments — credential signup and the Clerk webhook — still work', async () => {
  for (const source of referralService.REFERRAL_SIGNUP_SOURCES) {
    updates.length = 0;
    referrerGrants = { granted: 0, rewarded: 0 };
    const result = await referralService.recordReferralSignup({
      referredUserId: `user-${source}`,
      referredOrgId: `org-${source}`,
      referralCode: 'SHARE123',
      source,
    });
    assert.ok(result, `${source} is one of the two moments a code may be applied`);
  }
});

test('a referrer at the cap attributes nothing further — no row, no free month for the puppet', async () => {
  updates.length = 0;
  referrerGrants = { granted: referralService.REFERRAL_REWARDED_CAP, rewarded: 2 };

  const result = await referralService.recordReferralSignup({
    referredUserId: 'user-puppet',
    referredOrgId: 'org-puppet',
    referralCode: 'SHARE123',
    source: 'signup',
  });

  assert.equal(result, null);
  assert.equal(updates.filter((entry) => entry.kind === 'referral_insert').length, 0);
  assert.equal(updates.filter((entry) => entry.kind === 'org_reward').length, 0,
    'the referred side is paid at signup, so the cap has to stop the row being written at all');
});

test('one under the cap still pays', async () => {
  updates.length = 0;
  referrerGrants = { granted: referralService.REFERRAL_REWARDED_CAP - 1, rewarded: 0 };
  const result = await referralService.recordReferralSignup({
    referredUserId: 'user-referred-9',
    referredOrgId: 'org-referred-9',
    referralCode: 'SHARE123',
    source: 'signup',
  });
  assert.ok(result, 'the cap is a ceiling, not an off switch');
  assert.equal(updates.filter((entry) => entry.kind === 'org_reward').length, 1);
});

test('an activation beyond the cap is recorded but pays the referrer nothing', async () => {
  updates.length = 0;
  referrerGrants = { granted: referralService.REFERRAL_REWARDED_CAP, rewarded: referralService.REFERRAL_REWARDED_CAP };

  const activated = await referralService.activateReferralForActor(
    { id: 'user-referred', org_id: 'org-referred' },
    'first_sync'
  );

  assert.equal(activated, false, 'nothing was paid, so this did not "activate" in the paying sense');
  assert.equal(updates.filter((entry) => entry.kind === 'org_reward').length, 0);
  const marked = updates.filter((entry) => entry.kind === 'referral_update');
  assert.equal(marked.length, 1, 'the referral is still recorded — it really did activate');
  referrerGrants = { granted: 0, rewarded: 0 };
});

test('the overview says where somebody stands instead of letting them find the ceiling', async () => {
  referrerGrants = { granted: 3, rewarded: 2 };
  const overview = await referralService.listReferralOverview({ id: 'user-referrer', org_id: 'org-referrer' });
  assert.equal(overview.reward_cap, referralService.REFERRAL_REWARDED_CAP);
  assert.equal(overview.granted_count, 3);
  assert.equal(overview.rewarded_count, 2);
  assert.equal(overview.cap_reached, false);
  referrerGrants = { granted: 0, rewarded: 0 };
});

test('a referral month grants a Pro overlay without mutating the base tier', async () => {
  const entitlements = await entitlementService.getEntitlements('org-referred');
  assert.equal(entitlements.tier, 'free');
  assert.equal(entitlements.referral_premium_active, true);
  assert.equal(entitlements.referral_reward_tier, 'developer_basic');
  assert.equal(entitlements.features.auto_sync, true);
  assert.equal(entitlements.features.api_access, false);
  assert.equal(entitlements.features.context_sharing, false);
  // Proof the limits actually merged: free 1, Pro 90, merged by Math.max.
  assert.equal(entitlements.limits.audit_retention_days, 90);
  // The overlay must never reintroduce a tool-count cap.
  assert.strictEqual(entitlements.limits.included_integrations, null);
});

test.after(() => {
  Date.now = realDateNow;
});

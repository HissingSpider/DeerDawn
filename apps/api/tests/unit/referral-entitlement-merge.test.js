const test = require('node:test');
const assert = require('node:assert');

const { getEntitlementsFromOrg } = require('../../src/services/entitlementService');
const { PLANS } = require('../../src/config/plans');

// The referral reward is "a free month of Pro" (REFERRAL_REWARD_TIER =
// developer_basic, 30 days). It is applied as an entitlement OVERLAY on top of
// the org's real tier, merged by entitlementService.mergeLimits.
//
// mergeLimits used to collapse null and undefined together with `== null`, and
// when the overlay's value was null it returned the BASE's number — so
// "unlimited" lost to a cap. Every limit Free bounds is expressed by Pro as
// null, so the reward lifted NONE of them: a referred user was told they had Pro
// and still hit the memory window and the skill cap.
//
// Rewritten 2026-08-27, when the workspace cap was removed from Free. The bug
// class is unchanged (null must beat a number in both merge directions); it is
// now demonstrated on history_days and included_skills, which are the limits
// Free still bounds. included_projects is null on BOTH sides now, so it can no
// longer witness anything — asserting on it would be measuring nothing, which
// the premise guard below exists to prevent.
//
// getEntitlementsFromOrg is a pure function of the org row, so these drive the
// real merge with no database.

const REFERRED_FREE_ORG = {
  plan_tier: 'free',
  subscription_status: 'active',
  referral_premium_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
};

test('the reward actually lifts the limits Free is gated on', async () => {
  const { limits, referral_premium_active } = getEntitlementsFromOrg(REFERRED_FREE_ORG);
  assert.equal(referral_premium_active, true);

  // Guard the premise: if Free ever stops capping these, or Pro stops expressing
  // them as unlimited, this test is measuring nothing and should be rewritten.
  assert.ok(Number.isFinite(PLANS.free.limits.history_days), 'premise: Free caps history');
  assert.ok(Number.isFinite(PLANS.free.limits.included_skills), 'premise: Free caps skills');
  assert.strictEqual(PLANS.developer_basic.limits.history_days, null, 'premise: Pro is forever');
  assert.strictEqual(PLANS.developer_basic.limits.included_skills, null, 'premise: Pro is unlimited');

  // strictEqual, not equal: undefined == null would pass and prove nothing.
  assert.strictEqual(limits.history_days, null, 'memory does not age out during the reward month');
  assert.strictEqual(limits.included_skills, null, 'same null-beats-cap rule, same bug');
});

test('unlimited beats a cap in both directions, and the larger cap still wins', async () => {
  const { limits } = getEntitlementsFromOrg(REFERRED_FREE_ORG);
  // Both sides declare a number: the more generous one survives. This is the one
  // case the old implementation already got right, so it must not regress.
  assert.equal(limits.audit_retention_days, 90, 'Free 1 vs Pro 90 → 90');
  assert.equal(limits.included_admins, 1, 'equal on both sides → unchanged');
  // Both sides already null stays null.
  assert.strictEqual(limits.included_decisions, null);
  assert.strictEqual(limits.included_integrations, null, 'the overlay must never reintroduce a tool cap');
});

test('an org with no active reward keeps every Free cap', async () => {
  const plain = getEntitlementsFromOrg({ plan_tier: 'free', subscription_status: 'active' });
  assert.equal(plain.referral_premium_active, false);
  assert.equal(plain.limits.history_days, PLANS.free.limits.history_days, 'the fix must not leak Pro limits to everyone');
  assert.equal(plain.limits.included_skills, PLANS.free.limits.included_skills);

  const expired = getEntitlementsFromOrg({
    plan_tier: 'free',
    subscription_status: 'active',
    referral_premium_until: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(expired.referral_premium_active, false);
  assert.equal(expired.limits.history_days, PLANS.free.limits.history_days, 'caps return when the month lapses');
  assert.equal(expired.limits.included_skills, PLANS.free.limits.included_skills);
});

test('an inactive subscription suppresses the reward entirely', async () => {
  // A past_due/cancelled org must not be able to ride a referral overlay back to
  // paid limits — the status gate runs before the overlay is even considered.
  for (const subscription_status of ['past_due', 'cancelled', 'unpaid', 'trial_expired']) {
    const ent = getEntitlementsFromOrg({ ...REFERRED_FREE_ORG, subscription_status });
    assert.equal(ent.referral_premium_active, false, `${subscription_status} must not carry the reward`);
    assert.equal(ent.limits.history_days, PLANS.free.limits.history_days, `${subscription_status} stays capped`);
  }
});

test('a key absent from one side is taken from the other, not treated as unlimited', async () => {
  // The null-vs-undefined distinction is the whole fix. `undefined` means the
  // plan says nothing and must defer; only an explicit null means unlimited.
  //
  // This used to ride on real plan data: developer_pro declared
  // context_sharing_seats and Free did not. That asymmetry is gone — the key was
  // renamed included_seats and BOTH tiers now declare it, because a tier that
  // omits a seat limit reads as uncapped and would let a free workspace invite
  // the world. So the rule is driven directly rather than through a coincidence
  // of plan shape that could vanish again without anyone noticing.
  const { mergeLimits } = require('../../src/services/entitlementService');

  assert.strictEqual(
    Object.keys(PLANS.free.limits).filter((k) => !(k in PLANS.developer_pro.limits)).length, 0,
    'premise: the tiers share a key set, so this cannot be witnessed via real plans'
  );

  assert.deepStrictEqual(
    mergeLimits({ declared: 5 }, {}),
    { declared: 5 },
    'an absent overlay key defers to the base rather than reading as unlimited'
  );
  assert.deepStrictEqual(
    mergeLimits({}, { declared: 5 }),
    { declared: 5 },
    'an absent base key defers to the overlay'
  );
  assert.deepStrictEqual(
    mergeLimits({ declared: 5 }, { declared: null }),
    { declared: null },
    'an explicit null is unlimited and beats a cap'
  );
  assert.deepStrictEqual(
    mergeLimits({ declared: null }, { declared: 5 }),
    { declared: null },
    'and it beats a cap in the other direction too'
  );

  // The seat cap itself must survive the referral overlay intact — a free month
  // of Pro must not silently hand somebody a bigger team.
  const paid = getEntitlementsFromOrg({ plan_tier: 'developer_pro', subscription_status: 'active' });
  assert.equal(paid.limits.included_seats, PLANS.developer_pro.limits.included_seats);
});

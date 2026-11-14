/**
 * What a workspace is offered has to match what the API will actually do.
 *
 * Two defects, both "the page described a different transaction than the one
 * the button performs":
 *
 *  - The new-team wizard creates a workspace as { plan: free, account_type:
 *    organization } and relies on billing checkout to make it Team.
 *    /settings/plan gave every account_type 'organization' workspace NO upgrade
 *    targets, so the workspace built to be upgraded had no upgrade button and
 *    was told it was "managed with the DeerDawn team".
 *  - "14 days free — nothing is charged until the trial ends" was shown to
 *    everyone looking at Team. The trial is a property of a NEW Stripe
 *    Checkout; a workspace that already pays is moved in place, prorated, with
 *    no trial fields sent at all.
 *
 * Run: `tsx --test src/lib/billingOffer.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';

import { teamTrialAlreadyUsed, teamTrialApplies, teamUpgradeIsInPlace, upgradeTargetsFor } from './billingOffer';

// ── Upgrade targets ─────────────────────────────────────────────────────────

test('a wizard-made team (free, shared workspace) can be upgraded to Team', () => {
  // GET /orgs/usage for the founder switched into the team they just made.
  const targets = upgradeTargetsFor({ tier: 'free', isPersonalWorkspace: false });
  assert.deepStrictEqual(targets, ['developer_pro']);
});

test('a shared workspace is not offered the one-person plan', () => {
  // Pro has team_management off: nobody else could be invited into what was
  // bought, which is the only reason the workspace exists.
  assert.ok(!upgradeTargetsFor({ tier: 'free', isPersonalWorkspace: false }).includes('developer_basic'));
});

test('a personal Free account is offered Pro, then Team', () => {
  assert.deepStrictEqual(upgradeTargetsFor({ tier: 'free', isPersonalWorkspace: true }), ['developer_basic', 'developer_pro']);
});

test('an older API build that does not say which workspace this is gets the full ladder', () => {
  assert.deepStrictEqual(upgradeTargetsFor({ tier: 'free' }), ['developer_basic', 'developer_pro']);
});

test('Pro can move up to Team; Team is the top of the ladder', () => {
  assert.deepStrictEqual(upgradeTargetsFor({ tier: 'developer_basic', isPersonalWorkspace: true }), ['developer_pro']);
  assert.deepStrictEqual(upgradeTargetsFor({ tier: 'developer_pro', isPersonalWorkspace: false }), []);
});

test('a plan self-serve cannot move still gets no targets', () => {
  // What the old account_type gate was really protecting: comped governance
  // tiers and lifetime. That is decided from the tier, so it survives.
  for (const tier of ['starter', 'growth', 'scale', 'pilot', 'enterprise', 'lifetime']) {
    assert.deepStrictEqual(upgradeTargetsFor({ tier, isPersonalWorkspace: true }), [], tier);
    assert.deepStrictEqual(upgradeTargetsFor({ tier, isPersonalWorkspace: false }), [], tier);
  }
});

// ── The trial promise ───────────────────────────────────────────────────────

test('a brand-new checkout is promised the trial', () => {
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: null }), true);
});

test('a paying Pro subscriber upgrading in place is NOT promised a trial they will not get', () => {
  assert.strictEqual(
    teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'developer_basic', stripeCustomerId: 'cus_123' }),
    false,
  );
});

test('a free workspace that has been through Stripe before still gets a new checkout, and the trial', () => {
  // Churned and came back: there is no live subscription to move, so
  // /billing/checkout opens a real Checkout session, which carries the trial.
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: 'cus_123' }), true);
});

test('a comped paid plan with no Stripe customer goes through a new checkout, and the trial', () => {
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'developer_basic', stripeCustomerId: null }), true);
});

test('no plan but Team has a trial to promise', () => {
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_basic', currentTier: 'free', stripeCustomerId: null }), false);
  assert.strictEqual(teamTrialApplies({ targetPlan: null, currentTier: 'free' }), false);
});

// ── One Team trial per workspace (owner's decision, 2026-09-29) ─────────────

const TRIALED = '2026-09-01T10:00:00.000Z';

test('a workspace that has had its Team trial is NOT promised another', () => {
  // Free again after the trial ended or was cancelled: a real checkout opens,
  // and the API sends no trial days, so no surface may promise one.
  assert.strictEqual(
    teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: 'cus_123', teamTrialStartedAt: TRIALED }),
    false,
  );
  assert.strictEqual(
    teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: null, teamTrialStartedAt: TRIALED }),
    false,
  );
});

test('a workspace that has never had one is still promised the trial (null and absent both mean never)', () => {
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: null, teamTrialStartedAt: null }), true);
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: null }), true);
});

test('teamTrialAlreadyUsed is true only for a workspace that would open a new Team checkout after its trial', () => {
  const used = { targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: 'cus_123', teamTrialStartedAt: TRIALED };
  assert.strictEqual(teamTrialAlreadyUsed(used), true);
  // Never had one: nothing to say.
  assert.strictEqual(teamTrialAlreadyUsed({ ...used, teamTrialStartedAt: null }), false);
  // Paying Pro, moved in place: the prorated-move copy already tells the truth.
  assert.strictEqual(teamTrialAlreadyUsed({ ...used, currentTier: 'developer_basic' }), false);
  // Only Team has a trial.
  assert.strictEqual(teamTrialAlreadyUsed({ ...used, targetPlan: 'developer_basic' }), false);
});

test('a different, new workspace of the same person is offered the trial: it is the workspace that carries the fact', () => {
  // The new workspace's own payload has no team_trial_started_at.
  assert.strictEqual(teamTrialApplies({ targetPlan: 'developer_pro', currentTier: 'free', stripeCustomerId: null, teamTrialStartedAt: undefined }), true);
});

// ── A first payment that never went through (owner's answer, 2026-09-29) ────

test('an incomplete subscription is not one to move: the workspace checks out again, and the trial is judged on its own record', () => {
  const incomplete = { targetPlan: 'developer_pro', currentTier: 'developer_pro', stripeCustomerId: 'cus_1', subscriptionStatus: 'incomplete' };
  assert.strictEqual(teamUpgradeIsInPlace(incomplete), false);
  // Never had a trial: a real checkout opens and may carry one.
  assert.strictEqual(teamTrialApplies(incomplete), true);
  // Had one: charged from the start, and the page says so.
  assert.strictEqual(teamTrialApplies({ ...incomplete, teamTrialStartedAt: TRIALED }), false);
  assert.strictEqual(teamTrialAlreadyUsed({ ...incomplete, teamTrialStartedAt: TRIALED }), true);
  // Paying, as before.
  assert.strictEqual(teamUpgradeIsInPlace({ ...incomplete, subscriptionStatus: 'active' }), true);
});

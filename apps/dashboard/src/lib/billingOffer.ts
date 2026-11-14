/**
 * What a workspace may be OFFERED, as opposed to what a plan costs (planCopy).
 *
 * Two questions that three pages were each answering inline, and each getting
 * wrong in a different way:
 *
 *  1. Which self-serve plans can this workspace move up to?
 *  2. Does moving to Team come with the free trial?
 *
 * Pure functions over the two payloads the dashboard already has (GET
 * /orgs/usage and the bootstrap), so the answers can be tested without
 * rendering a page and cannot drift between the pages that ask.
 */

import { isSelfServePlan } from '@/lib/planCopy';

/**
 * Self-serve plans in ascending order, so "what can this workspace buy next" is
 * a slice rather than a branch. Free can buy Pro or Team; Pro can buy Team;
 * Team is the top of the self-serve ladder.
 */
export const SELF_SERVE_LADDER: readonly string[] = ['developer_basic', 'developer_pro'];

/** Ladder plans sold to ONE person. A shared workspace has no use for them:
 *  team_management is off, so nobody else could be invited into what was bought. */
const SINGLE_PERSON_PLANS: readonly string[] = ['developer_basic'];

export type UpgradeTargetInput = {
  tier: string;
  /** OrgUsageSummary.is_personal_workspace — false when the caller is switched
   *  into a workspace other than their own account. Absent on older API builds. */
  isPersonalWorkspace?: boolean | null;
};

/**
 * Everything above the current plan that has a cart.
 *
 * `account_type` is deliberately NOT an input. /settings/plan used to return no
 * targets at all for any workspace whose account_type was 'organization', on the
 * theory that an organization is sales-managed. But the new-team wizard creates
 * every team as { plan: 'free', account_type: 'organization' } and its own
 * comment says billing checkout "is how it becomes Team" — so the one workspace
 * that exists to be upgraded to Team was the one workspace whose billing page
 * offered no upgrade, and said it was "managed with the DeerDawn team" instead.
 *
 * What the old gate was really protecting is a plan that is not on the ladder
 * (a comped governance tier, lifetime): self-serve cannot move those, and that
 * is decided from the TIER, which is what `onLadder` does.
 */
export function upgradeTargetsFor({ tier, isPersonalWorkspace }: UpgradeTargetInput): string[] {
  const ladderIndex = SELF_SERVE_LADDER.indexOf(tier);
  // Free sits below the ladder; anything else that is not ON it gets no targets
  // rather than the whole list.
  const onLadder = tier === 'free' || ladderIndex >= 0;
  if (!onLadder) return [];
  return SELF_SERVE_LADDER
    .slice(ladderIndex + 1)
    .filter(isSelfServePlan)
    .filter((planId) => isPersonalWorkspace !== false || !SINGLE_PERSON_PLANS.includes(planId));
}

export type TrialOfferInput = {
  /** The plan being offered. Only Team has a trial (plans.js trial_days). */
  targetPlan: string | null | undefined;
  /** The workspace's current tier. */
  currentTier: string | null | undefined;
  /** organizations.stripe_customer_id — present once the workspace has ever
   *  been through Stripe. */
  stripeCustomerId?: string | null;
  /** organizations.team_trial_started_at (GET /orgs/usage plan, the bootstrap
   *  org): when this workspace's Team trial started, as Stripe confirmed it.
   *  Absent or null means it has never had one. There is ONE per workspace. */
  teamTrialStartedAt?: string | null;
  /** organizations.subscription_status. `incomplete` (the first payment never
   *  went through) is not a subscription to move: the workspace checks out again. */
  subscriptionStatus?: string | null;
};

/**
 * May this surface promise the Team free trial to THIS workspace?
 *
 * The trial is a property of a NEW subscription: createCheckoutSession passes
 * trial_period_days to Stripe Checkout. A workspace that is already paying does
 * not go through Checkout at all — POST /billing/checkout moves its existing
 * subscription onto Team in place, prorated, effective immediately, and sends no
 * trial fields. Every surface nevertheless told that buyer "14 days free —
 * nothing is charged until the trial ends", about a change that is charged for
 * from the first minute.
 *
 * A paid tier with a Stripe customer is the signal that the in-place path will
 * be taken. It errs in one direction only: a comped plan that once had a Stripe
 * customer would get a real checkout (and the trial) without having been
 * promised one. Under-promising a trial is a pleasant surprise; over-promising
 * one is a charge the customer was told would not happen.
 *
 * Whether an in-place upgrade SHOULD get a trial (Stripe's trial_end on the
 * update) is a billing-policy decision, not a copy one, and is not made here.
 */
export function teamTrialApplies({ targetPlan, currentTier, stripeCustomerId, teamTrialStartedAt, subscriptionStatus }: TrialOfferInput): boolean {
  if (targetPlan !== 'developer_pro') return false;
  // ONE TEAM TRIAL PER WORKSPACE (the owner's decision, 2026-09-29). A workspace
  // that has had one is charged from the start at its next Team checkout, so no
  // surface may promise it another. Under-promising is a pleasant surprise;
  // this is the over-promise the rule exists to prevent.
  if (teamTrialStartedAt) return false;
  return !teamUpgradeIsInPlace({ currentTier, stripeCustomerId, subscriptionStatus });
}

/**
 * Will moving this workspace to Team MOVE a subscription it already pays for
 * (prorated, no checkout, no trial), rather than open a new checkout? A paid
 * tier with a Stripe customer is the signal, as in teamTrialApplies.
 */
export function teamUpgradeIsInPlace({ currentTier, stripeCustomerId, subscriptionStatus }: Pick<TrialOfferInput, 'currentTier' | 'stripeCustomerId' | 'subscriptionStatus'>): boolean {
  if (subscriptionStatus === 'incomplete') return false;
  return Boolean(currentTier) && currentTier !== 'free' && Boolean(stripeCustomerId);
}

/**
 * Is this a workspace that WOULD open a new Team checkout and has already had
 * its one trial? Then the page says so, instead of saying nothing (which reads
 * as a trial that failed to show) or promising one.
 */
export function teamTrialAlreadyUsed({ targetPlan, currentTier, stripeCustomerId, teamTrialStartedAt, subscriptionStatus }: TrialOfferInput): boolean {
  if (targetPlan !== 'developer_pro' || !teamTrialStartedAt) return false;
  return !teamUpgradeIsInPlace({ currentTier, stripeCustomerId, subscriptionStatus });
}

/**
 * What /checkout is allowed to do on its own, and what it has to ask about
 * first.
 *
 * THE BUG THIS EXISTS FOR. /checkout read `?plan`, `?seats` and `?billing` off
 * the URL and POSTed /billing/checkout the moment the session resolved — no
 * button, no confirm step. For a workspace with no subscription that is fine:
 * the POST answers with a Stripe Checkout URL, and Stripe's own page is the
 * confirmation. For a workspace that ALREADY has a live subscription there is
 * no Stripe page at all — the API moves the existing subscription in place,
 * prorated, effective immediately. So a signed-in monthly Pro subscriber who
 * clicked "Try Team free for 14 days" on the marketing pricing page landed on
 * /checkout?plan=developer_pro&seats=2&billing=yearly and their live
 * subscription silently became Team x2 on ANNUAL billing, charged at once, with
 * no trial and nothing to press. Any link of that shape did it on a GET.
 *
 * Two pure decisions, separated from the page so they can be tested without
 * rendering it:
 *
 *  - `resolveCheckoutCadence` — which billing cadence, if any, to send.
 *  - `checkoutAutoSubmitDecision` — may the page post by itself, and if not, why.
 */

import { billingPageRefusal } from './billingRefusal';
import { mayOfferBilling } from './billingAccess';

/** Cadences the API accepts. `undefined` means "send none, keep what you have". */
export type BillingCadence = 'monthly' | 'annual';

/**
 * The cadence the URL NAMED, or null when it named none.
 *
 * `?billing=yearly` is what marketing links carry and `annual` is what the API
 * calls it, so both read as annual. Everything else — absent, misspelled, an
 * array from a repeated key — is "not named", which is a different answer from
 * "annual" and the difference is a charge.
 */
export function namedCadence(billing: unknown): BillingCadence | null {
  const raw = typeof billing === 'string' ? billing.trim().toLowerCase() : '';
  if (raw === 'monthly') return 'monthly';
  if (raw === 'annual' || raw === 'yearly') return 'annual';
  return null;
}

/**
 * Which cadence to send to POST /billing/checkout.
 *
 * NEW SUBSCRIPTION (`hasSubscription: false`): a Stripe Checkout session needs a
 * concrete price, so an unnamed cadence falls back to annual — the deliberate
 * annual-first default, and the buyer can still see and change it on Stripe's
 * page before paying.
 *
 * EXISTING SUBSCRIPTION (`hasSubscription: true`): sending a cadence MOVES the
 * billing interval, and an interval change makes Stripe close the current period
 * and charge the prorated difference immediately. billing.js already keeps the
 * current cadence when the request names none, so a URL that did not name one
 * must send none. The old page turned every unnamed link into `annual` and
 * billed a monthly subscriber for a year on the spot.
 *
 * `lifetime` is a one-time payment and has no annual price; it is always sent as
 * monthly, exactly as the page did before.
 */
export function resolveCheckoutCadence(
  query: { billing?: unknown; plan?: unknown },
  options: { hasSubscription: boolean },
): BillingCadence | undefined {
  if (query.plan === 'lifetime') return 'monthly';
  const named = namedCadence(query.billing);
  if (named) return named;
  return options.hasSubscription ? undefined : 'annual';
}

/**
 * Does this workspace already have a subscription that POST /billing/checkout
 * would MOVE rather than create?
 *
 * The route branches on `organizations.stripe_subscription_id`, which GET
 * /orgs/usage does not expose. A paid tier with a Stripe customer is the signal
 * that is available, and it is the same one lib/billingOffer uses to decide
 * whether to promise the Team trial — the two answers must agree or the page
 * promises a trial on a screen that warns about an immediate charge.
 *
 * It errs toward "yes, ask first": a comped paid tier that once had a Stripe
 * customer gets a confirmation step it did not strictly need. One extra click is
 * not the failure mode worth optimising against here.
 */
export function workspaceHasSubscription(plan: {
  tier?: string | null;
  stripe_customer_id?: string | null;
  status?: string | null;
} | null | undefined): boolean {
  if (!plan) return false;
  // A first payment that never went through is not a subscription to move: the
  // workspace checks out again, and the API ends the unfinished one.
  if (plan.status === 'incomplete') return false;
  const tier = plan.tier || '';
  return Boolean(tier) && tier !== 'free' && Boolean(plan.stripe_customer_id);
}

/**
 * WHAT THE CONFIRM PANEL IS CONFIRMING.
 *
 * It said one thing to everybody: "This workspace already has a subscription
 * and the card on file is charged a prorated amount." That sentence was shown
 * to a reader whose /orgs/usage read had FAILED (we do not know what they have)
 * and to a lifetime buyer (a one-time payment through Stripe, no card on file
 * being charged for anything). Stating a specific charge to somebody it will
 * not happen to is the same class of wrong as the silent charge this panel was
 * built to stop.
 */
export type ConfirmReason =
  /** A live subscription is moved in place: prorated, immediate, no Stripe page. */
  | 'plan_change'
  /** We could not read the current plan. Say so, and still require the press. */
  | 'unknown_state'
  /** Lifetime: one payment, taken on Stripe's own page. */
  | 'one_time'
  /** Same plan, MORE seats. */
  | 'seat_increase'
  /** Same plan, FEWER seats. The only case that may send `allow_reduce`. */
  | 'seat_reduction';

/** Where a refused checkout can send the reader, when it can send them anywhere. */
export type CheckoutExit =
  /** They are in somebody else's workspace and their own is one click away. */
  | 'own_workspace'
  /** They already have this plan here; seats are changed in team settings. */
  | 'team_settings'
  /** A move to a LOWER plan: checkout refuses it (400 invalid_plan), and the
   *  Stripe billing portal is where a subscription is moved down or cancelled. */
  | 'billing_portal'
  | 'none';

export type CheckoutAutoSubmit =
  /** No subscription to disturb: post now and hand the buyer to Stripe, whose
   *  own page is the confirmation. This is the unchanged happy path. */
  | { action: 'submit' }
  /** A live subscription would be changed in place, so show what changes and
   *  post only when the person presses Confirm. */
  | { action: 'confirm'; reason: ConfirmReason; seatChange?: { from: number; to: number } }
  /** The person cannot change this workspace's billing at all — say so rather
   *  than posting a request the server will refuse. */
  | { action: 'refuse'; reason: string; exit: CheckoutExit };

/**
 * May the page post /billing/checkout without being told to?
 *
 * `workspaceRole` is the caller's role in the BOUND workspace (GET
 * /teams/workspaces). Only an owner may change billing — requireBillingOwner in
 * billing.js refuses everyone else with "Only a workspace owner can change its
 * billing" — so a member or viewer is told that here instead of watching a
 * spinner end in a 403.
 *
 * THE REFUSAL NEEDS A WAY THROUGH. /checkout is a standalone page with no
 * workspace switcher on it: an invited teammate who wanted their OWN Pro was
 * told to "switch to your own workspace first" next to two buttons that both
 * went backwards. `boundIsPersonal: false` says there is a personal workspace to
 * switch to, and the page offers it as a control rather than as advice. Never
 * automatically: switching workspaces under somebody mid-purchase is the same
 * mistake in the other direction.
 *
 * `hasSubscription: null` means the usage read has not answered, or failed.
 * That is deliberately treated as "confirm", not as "no subscription": the whole
 * defect is money moving without a press, and a transient API failure must not
 * be the thing that re-opens it. The cost of being wrong in this direction is
 * one extra click.
 */
export function checkoutAutoSubmitDecision(input: {
  hasSubscription: boolean | null;
  workspaceRole?: string | null;
  /** False when the bound workspace belongs to somebody else. Undefined on an
   *  older API, which is treated as "no exit to offer" rather than guessed. */
  boundIsPersonal?: boolean | null;
  targetPlan?: string | null;
  currentTier?: string | null;
  /** Seats the URL asked for, and seats the subscription is billed for today.
   *  `currentSeats: null` is UNKNOWN, which is never treated as zero. */
  requestedSeats?: number | null;
  currentSeats?: number | null;
  /**
   * The seat numbers the SERVER refused with (409 seat_reduction_not_confirmed),
   * once it has. It answered before changing anything, and what it said is not a
   * guess: there is a subscription, it is billed for `from` seats, and `to` were
   * asked for. See the loop this closes below.
   */
  serverSeatRefusal?: { from: number; to: number } | null;
}): CheckoutAutoSubmit {
  const role = (input.workspaceRole || '').toLowerCase();
  if (role === 'member' || role === 'viewer') {
    const exit: CheckoutExit = input.boundIsPersonal === false ? 'own_workspace' : 'none';
    return {
      action: 'refuse',
      exit,
      reason: exit === 'own_workspace'
        ? 'Only a workspace owner can change this workspace’s billing. Ask an owner to make this change, or buy this for your own workspace instead.'
        : 'Only a workspace owner can change this workspace’s billing. Ask an owner to make this change.',
    };
  }

  // THE SERVER HAS ALREADY ANSWERED, SO STOP GUESSING.
  //
  // A 409 seat_reduction_not_confirmed is the one input here that is not
  // inferred: it comes from the thing that would do the work, it changed
  // nothing, and it carries both numbers. Without this the page could not act
  // on it when /orgs/usage had failed — `hasSubscription: null` resolved to
  // `unknown_state`, whose Confirm sends `submit(false)`, which is refused
  // identically, which leaves the decision unchanged. The same press, forever.
  //
  // Below the role check, never above it: a member's press must not become a
  // confirmed reduction because the server happened to answer with numbers.
  const refused = input.serverSeatRefusal;
  if (refused && Number.isFinite(refused.from) && Number.isFinite(refused.to)) {
    return { action: 'confirm', reason: 'seat_reduction', seatChange: { from: refused.from, to: refused.to } };
  }

  if (input.hasSubscription === false) return { action: 'submit' };
  if (input.hasSubscription === null) return { action: 'confirm', reason: 'unknown_state' };
  if (input.targetPlan === 'lifetime') return { action: 'confirm', reason: 'one_time' };

  // SAME PLAN, DIFFERENT SEAT COUNT. The marketing "Try Team" link carries
  // seats=2, so a Team owner with five seats who follows it is asking, without
  // knowing it, to pay for three fewer. That is a real request the API will
  // honour, so it is never sent on a guess.
  const samePlan = Boolean(input.targetPlan) && input.targetPlan === input.currentTier;
  if (samePlan) {
    const requested = numberOrNull(input.requestedSeats);
    const current = numberOrNull(input.currentSeats);
    if (requested === null) {
      // No seat count in play at all (a per-person plan): buying the plan you
      // already have changes nothing, and there is no seat screen to send
      // anybody to.
      return {
        action: 'refuse',
        exit: 'none',
        reason: 'This workspace is already on this plan. Nothing would change, and nothing has been charged.',
      };
    }
    if (current === null) {
      // Unknown seats: do not offer a reduction at all, and do not dress a
      // no-op up as a purchase.
      return {
        action: 'refuse',
        exit: 'team_settings',
        reason: 'This workspace is already on this plan. Change how many seats it has in team settings.',
      };
    }
    if (requested < current) {
      return { action: 'confirm', reason: 'seat_reduction', seatChange: { from: current, to: requested } };
    }
    if (requested > current) {
      return { action: 'confirm', reason: 'seat_increase', seatChange: { from: current, to: requested } };
    }
    return {
      action: 'refuse',
      exit: 'team_settings',
      reason: 'This workspace is already on this plan with this many seats. Nothing would change, and nothing has been charged.',
    };
  }

  // A LOWER PLAN IS NOT SOMETHING CHECKOUT SELLS.
  //
  // POST /billing/checkout refuses "the same or lower tier" with 400
  // invalid_plan. Offering the prorated plan-change panel first meant a Team
  // owner on /checkout?plan=developer_basic read a confirmation, pressed it,
  // and got "We couldn't start checkout. Retry once": a retry that could never
  // work. Refuse up front and send them to where a subscription is moved down.
  // The portal button only for a person the listing names as an owner (the one
  // rule, lib/billingAccess): with the role unknown, the refusal is said and no
  // billing button is offered.
  if (isLowerTier(input.targetPlan, input.currentTier)) {
    return {
      action: 'refuse',
      exit: mayOfferBilling({ role: input.workspaceRole }) ? 'billing_portal' : 'none',
      reason: LOWER_TIER_REFUSAL,
    };
  }

  return { action: 'confirm', reason: 'plan_change' };
}

/** The self-serve ladder, as the API orders it (config/plans.js getPlanOrder). */
const PLAN_ORDER: Record<string, number> = {
  free: 0,
  developer_basic: 1,
  developer_pro: 2,
  lifetime: 3,
};

/** True only when BOTH plans are known and the target sits below the current one. */
export function isLowerTier(targetPlan?: string | null, currentTier?: string | null): boolean {
  if (!targetPlan || !currentTier) return false;
  const target = PLAN_ORDER[targetPlan];
  const current = PLAN_ORDER[currentTier];
  if (target === undefined || current === undefined) return false;
  return target < current;
}

export const LOWER_TIER_REFUSAL =
  'This workspace is already on a higher plan, so there is nothing to buy here. '
  + 'To move to a lower plan, use the billing portal. Nothing has been charged.';

/**
 * What a FAILED POST /billing/checkout should tell the person.
 *
 * Every failure used to become "We couldn't start checkout. Retry once", including
 * the ones the server had already explained and that no retry changes: a 400
 * invalid_plan (same or lower tier), a 400 seats_below_headcount (a confirmed
 * seat cut below the people already in the workspace). A 4xx is the server
 * answering, so its own sentence is shown; only a failure that carries no
 * answer (5xx other than 503, a network error) gets the generic retry copy.
 *
 * `refused` outcomes carry a way through, like the up-front refusals do.
 */
export type CheckoutFailure =
  | { kind: 'refused'; message: string; exit: CheckoutExit }
  | { kind: 'error'; message: string };

export const CHECKOUT_RETRY_MESSAGE =
  'We couldn’t start checkout. Retry once, then come back through Billing if it persists.';

export function checkoutFailure(error: unknown): CheckoutFailure {
  const candidate = (error && typeof error === 'object' ? error : {}) as {
    status?: unknown; code?: unknown; data?: Record<string, unknown> | null; message?: unknown;
  };
  const status = Number(candidate.status);
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  const reason = typeof candidate.code === 'string' && candidate.code
    ? candidate.code
    : candidate.data && typeof candidate.data === 'object' && typeof candidate.data.error === 'string'
      ? candidate.data.error
      : '';

  if (status === 503) {
    // A configuration failure the server has already named. Its sentence is
    // shown verbatim; "retry in a minute" would send a buyer round a loop.
    return {
      kind: 'error',
      message: `${message || 'Billing is unavailable.'} This is a configuration problem on our side, not something a retry fixes. `
        + 'Email support@deerdawn.com and we will sort it.',
    };
  }
  if (status === 400 && reason === 'invalid_plan') {
    return { kind: 'refused', exit: 'billing_portal', message: LOWER_TIER_REFUSAL };
  }
  // The bank has to confirm the payment, or a payment is overdue: nothing was
  // changed, and Stripe's billing page is the way through. See billingRefusal.
  const billingPage = billingPageRefusal(error);
  if (billingPage) {
    return { kind: 'refused', exit: 'billing_portal', message: billingPage.message };
  }
  if (status === 400 && reason === 'seats_below_headcount') {
    return {
      kind: 'refused',
      exit: 'team_settings',
      message: `${message || 'This workspace has more people than that many seats.'} Nothing has been charged.`,
    };
  }
  if (status >= 400 && status < 500 && status !== 401 && message) {
    return { kind: 'error', message };
  }
  return { kind: 'error', message: CHECKOUT_RETRY_MESSAGE };
}

/** Names the reduction rather than implying it: "Team stays Team; seats go from 5 to 2." */
export function seatChangeSentence(planName: string, change: { from: number; to: number }): string {
  return `${planName} stays ${planName}; seats go from ${change.from} to ${change.to}.`;
}

/**
 * The server's own refusal when it disagrees with us about the seat count.
 *
 * 409 `seat_reduction_not_confirmed` carries `current` and `requested`, and it
 * is the backstop for every path where the page could not read the roster (a
 * member of another workspace, a 403 on /teams/members, an older dashboard).
 * Nothing was charged, so the answer is to ASK using the server's numbers, never
 * to resend with `allow_reduce` on the page's own authority.
 */
export function seatReductionRefusal(error: unknown): { from: number; to: number } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; code?: unknown; data?: Record<string, unknown> | null };
  if (Number(candidate.status) !== 409) return null;
  const reason = typeof candidate.code === 'string' && candidate.code
    ? candidate.code
    : candidate.data && typeof candidate.data === 'object'
      ? candidate.data.error
      : undefined;
  if (reason !== 'seat_reduction_not_confirmed') return null;
  const from = numberOrNull(candidate.data?.current);
  const to = numberOrNull(candidate.data?.requested);
  if (from === null || to === null) return null;
  return { from, to };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

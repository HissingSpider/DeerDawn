/**
 * One source of truth for how plans are NAMED and PRICED in the dashboard.
 *
 * Before this module the same three facts — the price, the plan's name, and what
 * bounds the free tier — were copy-pasted across a dozen components. When the
 * 2026-08-27 pricing change landed they all went stale at once, and one of them
 * (the upgrade banner) ended up telling free users to pay for unlimited
 * workspaces they had just been given. Copy that repeats a number will drift
 * from the number the server enforces; the only durable fix is to stop
 * repeating it.
 *
 * The values here are mirrored from `apps/api/src/config/plans.js`, which is the
 * real source of truth — it is what checkout, entitlements and enforcement all
 * read. `plan-copy-matches-plans.test.ts` asserts the two agree, so this file
 * cannot silently fall behind the server again.
 *
 * Hosted pricing, 2026-11: developer_basic is sold as "Individual" at $12/mo
 * ($96/yr) and developer_pro as "Team" at $15 per seat per month ($150 per seat
 * per year). The plan ids and the Stripe prices did not change; only the name
 * "Pro" did. These are what the existing STRIPE_PRICE_DEVELOPER_BASIC[_ANNUAL]
 * and STRIPE_PRICE_DEVELOPER_PRO[_ANNUAL] prices charge. The superseded $10 Pro
 * price stays mapped on the API so nobody subscribed on it loses their plan.
 */

/** developer_basic. `publicName` in plans.js. The identifier keeps its old name
 *  (it was "Pro" until 2026-11) so every import keeps working; the VALUE is
 *  what renders, and planCopy.test.ts pins it to plans.js. */
export const PRO_PLAN_NAME = 'Individual';
/** The same name, under the name it has now. */
export const INDIVIDUAL_PLAN_NAME = PRO_PLAN_NAME;

/** developer_pro. Self-serve since 2026-09-02 — it is in the API's
 *  SELF_SERVE_PLAN_IDS and sold from marketing /pricing and /settings/upgrade. */
export const TEAM_PLAN_NAME = 'Team';

/**
 * Which plans have a CART, mirrored from SELF_SERVE_PLAN_IDS in
 * apps/api/src/config/plans.js and pinned to it by planCopy.test.ts.
 *
 * This is here because it was somewhere else — twice. /checkout and
 * /settings/plan each kept `new Set(['developer_basic'])`, written before Team
 * had Stripe prices and never revisited when it got them. Marketing's "Try Team
 * free for 14 days" hands the buyer to /checkout?plan=developer_pro; /checkout
 * consulted its own stale set, decided Team was sales-assisted and rendered
 * "Contact DeerDawn sales" without ever calling the API. The plan the pricing
 * page sells as a cart could not be bought from inside the product.
 *
 * A private copy of a server-side list is the same failure mode as a private
 * copy of a price: correct on the day it is typed, silent afterwards. One
 * mirror, pinned.
 */
export const SELF_SERVE_PLAN_IDS: readonly string[] = ['developer_basic', 'developer_pro'];

export function isSelfServePlan(planId: string | null | undefined): boolean {
  return typeof planId === 'string' && SELF_SERVE_PLAN_IDS.includes(planId);
}

export const PRICE_MONTHLY = 12;
export const PRICE_ANNUAL = 96;

/** developer_pro, per seat per month / per seat per year. Mirrors plans.js. */
export const TEAM_PRICE_MONTHLY = 15;
export const TEAM_PRICE_ANNUAL = 150;

/** plans.js limits.minimum_seats — the checkout floor, and therefore the most
 *  conservative honest multiplier for a Team purchase's conversion value. */
export const TEAM_MIN_SEATS = 2;
/** plans.js trial_days on developer_pro — what the checkout actually grants. */
export const TEAM_TRIAL_DAYS = 14;

/**
 * Everything about the ANNUAL case is DERIVED, never typed.
 *
 * Both plan pickers used to carry the yearly figures as their own literals —
 * `annualPrice: 8` on /settings/upgrade, `ANNUAL_PRICES = { developer_basic: 8 }`
 * on /select-plan — and both cards advertised "-20%" beside them. Eight was
 * right only because 96/12 happens to be 8; twenty per cent was never right at
 * all ($144 against $96 is 33%), and marketing's own card, which derives the
 * same number, has been printing 33 next to the dashboard's 20 ever since.
 *
 * A literal here is a number that is correct until the next price change and
 * silent afterwards, which is exactly how `price: 10` survived the rise to $12
 * on the highest-intent upgrade page in the product. So the only numbers typed
 * in this file are the two Stripe charges; every comparison is computed.
 */
export const PRICE_ANNUAL_PER_MONTH = PRICE_ANNUAL / 12;
/** What twelve months of monthly costs — the annual price's comparand. */
const TWELVE_MONTHS = PRICE_MONTHLY * 12;
/** Dollars an annual buyer keeps over a year of monthly. */
export const ANNUAL_SAVING = TWELVE_MONTHS - PRICE_ANNUAL;
/** The discount an annual toggle may advertise. */
export const ANNUAL_DISCOUNT_PCT = Math.round((ANNUAL_SAVING / TWELVE_MONTHS) * 100);
/** Team's yearly price per seat, expressed per month. Not a whole number
 *  ($150/12 = $12.50), which is why prices render through `money()` below
 *  rather than being pasted after a `$`. */
export const TEAM_PRICE_ANNUAL_PER_MONTH = TEAM_PRICE_ANNUAL / 12;
export const TEAM_ANNUAL_SAVING = TEAM_PRICE_MONTHLY * 12 - TEAM_PRICE_ANNUAL;

/**
 * The seat floor a per-seat checkout opens at, keyed by plan id.
 *
 * stripeService clamps to `limits.minimum_seats` regardless, so this is the
 * courtesy — Stripe opens already showing two seats rather than one the buyer
 * then has to correct — not the enforcement. Keyed by plan rather than branched
 * on `=== 'developer_pro'` so the second per-seat plan is a line of data.
 */
export const MIN_SEATS_BY_PLAN: Readonly<Record<string, number>> = {
  developer_pro: TEAM_MIN_SEATS,
};

/** Seats a checkout for `planId` should open at. 1 for a per-person plan. */
export function minSeatsFor(planId: string | null | undefined): number {
  return (planId && MIN_SEATS_BY_PLAN[planId]) || 1;
}

/**
 * Is this plan billed per person?
 *
 * Derived from the floor above rather than written as `=== 'developer_pro'` in
 * the surfaces that ask: a plan with a seat floor above one is a plan whose
 * price is multiplied by a headcount, and the second such plan should be a line
 * of data here rather than a branch in three components.
 */
export function isPerSeatPlan(planId: string | null | undefined): boolean {
  return minSeatsFor(planId) > 1;
}

/**
 * Format an amount for display: "$12", "$12.50". Whole dollars stay whole —
 * "$12.00" on a pricing card reads as a mistake — and anything with cents keeps
 * exactly two, because "$12.5" reads as one and "$8.333333" as a bug.
 */
export function money(amount: number): string {
  // To the cent FIRST: a figure derived from a non-whole one (12 x $8.333...,
  // less $80) comes out as 19.999999999999996, which is twenty dollars and
  // must not print as "$20.00".
  const cents = Math.round(amount * 100) / 100;
  return Number.isInteger(cents) ? `$${cents}` : `$${cents.toFixed(2)}`;
}
/** "$12/mo" / "$96/year" — so no component has to remember the format either. */
export const MONTHLY_LABEL = `$${PRICE_MONTHLY}/mo`;
export const ANNUAL_LABEL = `$${PRICE_ANNUAL}/year`;

/** A billing cycle, in the words the API's checkout takes. */
export type BillingCycle = 'monthly' | 'annual';

/**
 * Team's price for one billing cycle, as a phrase: "$15 per seat per month",
 * "$12.50 per seat per month, $150 per seat billed yearly".
 *
 * /select-plan told a buyer on the Annual toggle that "Team is $15 a seat" while
 * /settings/upgrade showed $12.50 for the same choice. A Team price with no
 * cycle is a monthly price by default, and a Team price with no unit reads as
 * the whole bill — Team's floor is two seats — so both are in every phrase.
 */
export function teamPricePhrase(cycle: BillingCycle): string {
  return cycle === 'annual'
    ? `${money(TEAM_PRICE_ANNUAL_PER_MONTH)} per seat per month, ${money(TEAM_PRICE_ANNUAL)} per seat billed yearly`
    : `${money(TEAM_PRICE_MONTHLY)} per seat per month`;
}

/** A month is 28 to 31 days and a year 365 or 366; nothing either cycle bills
 *  for falls between the two. */
const DAY_MS = 86_400_000;
const LONGEST_MONTH_DAYS = 31;

/**
 * The cycle a workspace is billed on, when the dashboard can KNOW it, else null.
 *
 * A card marked "Current plan" has to show what that person pays, not what the
 * page's billing toggle shows for the plans they could move to: /settings/upgrade
 * opens on Annual, and told a MONTHLY Pro subscriber their current plan was
 * "$8/mo" when they pay $12. So the current card never follows the toggle — it
 * follows this, and where this is null it states both cycles rather than
 * guessing one.
 *
 * Read off the billing period on record, never off the toggle:
 *   - both ends of the period: a month-long period is monthly, a year-long one
 *     annual, anything else (a trial, a partial period) says nothing;
 *   - only its end (all the bootstrap sends today): an end more than a month
 *     away can only be a yearly period. An end within the month is monthly OR
 *     the last month of a year, so it answers nothing;
 *   - a trial: its period is the trial, the same length on both cycles, so it
 *     answers nothing.
 */
export function billingCycleOnRecord(
  org: {
    subscription_status?: string | null;
    billing_period_start?: string | null;
    billing_period_end?: string | null;
  } | null | undefined,
  now: number = Date.now(),
): BillingCycle | null {
  if (!org || org.subscription_status === 'trialing') return null;
  const end = org.billing_period_end ? Date.parse(org.billing_period_end) : NaN;
  if (!Number.isFinite(end)) return null;
  const start = org.billing_period_start ? Date.parse(org.billing_period_start) : NaN;
  if (Number.isFinite(start)) {
    const days = (end - start) / DAY_MS;
    if (days > LONGEST_MONTH_DAYS + 1) return 'annual';
    if (days >= 27) return 'monthly';
    return null;
  }
  return end - now > (LONGEST_MONTH_DAYS + 1) * DAY_MS ? 'annual' : null;
}

/**
 * What Individual actually adds over Free, in the language the pricing page uses. Free is no
 * longer bounded by how much work you do — it is unlimited projects with a
 * 90-day window — so every one of these has to be something free genuinely does
 * NOT have. Naming a benefit free already includes is how the upgrade banner
 * came to sell people something they already owned.
 */
export const PRO_VALUE_LINE =
  'everything across your projects: cross-project search, the entities that show up in more than one, and history that never ages out';

/**
 * What Team adds over Individual. Everything here needs a second person to mean
 * anything, which is also why a one-seat Team is not sold.
 */
export const TEAM_VALUE_LINE =
  'one shared workspace: briefs that carry who worked each thing out, per-project privacy, and an audit log that names people';

/**
 * The reassurance line. Whenever the UI names something that costs money it must
 * also say what stays free, or the paid surface reads as a new cap — the exact
 * anxiety removing the project cap was meant to remove.
 */
export const STAYS_FREE_LINE = 'Your projects stay unlimited on Free.';

/**
 * Describe a free plan's bound from its LIVE entitlements rather than from a
 * hard-coded number, so a referral month (which grants Pro limits while
 * plan_tier still reads 'free') is described correctly.
 *
 * Returns null when there is nothing left to sell — every limit is unlimited.
 */
export function describeFreeBound(limits: {
  included_projects?: number | null;
  history_days?: number | null;
} | undefined): string | null {
  const historyDays = typeof limits?.history_days === 'number' ? limits.history_days : null;
  const projectLimit = typeof limits?.included_projects === 'number' ? limits.included_projects : null;

  if (projectLimit !== null && historyDays !== null) {
    return `Your plan keeps ${projectLimit} workspace${projectLimit === 1 ? '' : 's'} and the last ${historyDays} days of history.`;
  }
  if (historyDays !== null) {
    return `Your plan keeps the last ${historyDays} days of history, and unlimited projects.`;
  }
  if (projectLimit !== null) {
    return `Your plan keeps ${projectLimit} workspace${projectLimit === 1 ? '' : 's'}.`;
  }
  return null;
}

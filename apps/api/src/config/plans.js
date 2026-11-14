const TRIAL_DAYS = 0;
const TRIAL_PLAN = 'free';
const TRIAL_DECISION_LIMIT = 1000;

// --- Referral programme -----------------------------------------------------
// These are entitlement numbers (what an invite is worth, and how much of it one
// account can ever be given), so they live here with the rest of the plan
// arithmetic rather than inline in referralService — a route must never carry a
// magic number that decides how much free Pro the product hands out.
const REFERRAL_REWARD_TIER = 'developer_basic';
const REFERRAL_REWARD_DAYS = 30;
// How many referrals a single referrer can ever be paid for.
//
// The programme stacks: every qualified referral adds REFERRAL_REWARD_DAYS on
// top of whatever premium the org already has, and nothing bounded that. One
// person with a throwaway mailbox could mint sock-puppet accounts and
// accumulate unbounded Pro — and because the referred side is paid AT SIGNUP,
// each puppet also arrived holding 30 days of Pro of its own, so the farm paid
// twice per puppet.
//
// Ten is chosen as the honest-use ceiling rather than a fraud threshold:
// 10 x 30 days is most of a year of Pro, which is far more than word of mouth
// from one developer realistically produces, and the loss if somebody does farm
// it to the cap is bounded and small. Raise it when a real referrer complains
// about hitting it; that complaint is evidence the programme is working.
const REFERRAL_REWARDED_CAP = 10;

// The only two places an invite code may be applied: the credential signup
// route and the Clerk account-created webhook. Both run exactly once, while the
// account is being created. Anything else is "afterwards" and is refused — see
// referralService.recordReferralSignup.
const REFERRAL_SIGNUP_SOURCES = Object.freeze(['signup', 'clerk_webhook']);

// DeerDawn is context-sync only. The governance tiers (starter/growth/scale) are no
// longer sold or self-serve. Their PLANS definitions are kept inert for backward
// compatibility with any existing org/plan_tier rows and migrations.
//
// HOSTED PRICING, 2026-11 (the open-source move, decided by John):
//   - Self-host: free, everything unlocked (SELF_HOSTED mode, implemented
//     elsewhere; nothing in this catalog applies to a self-hosted install).
//   - Hosted Individual: $12 per person per month, $96 per year. Stored id
//     `developer_basic`.
//   - Hosted Team: $15 per seat per month, $150 per seat per year. Stored id
//     `developer_pro`.
//   Both are the EXISTING Stripe prices (STRIPE_PRICE_DEVELOPER_BASIC[_ANNUAL],
//   STRIPE_PRICE_DEVELOPER_PRO[_ANNUAL]); no new Stripe price was created.
//   - Free: every existing account keeps exactly today's Free entitlements
//     ("grandfathered for now"). Whether a NEW hosted signup still gets Free is
//     John's open question, so it is a switch, HOSTED_FREE_TIER_FOR_NEW_SIGNUPS,
//     defaulting to today's behaviour (see newSignupPlanState below).
//
// THE PLAN IDS AND PRICES DID NOT CHANGE, ONLY THE NAME "Pro". Individual is the
// old Pro (`developer_basic`) and Team is the old Team (`developer_pro`), with
// the same entitlements and the same Stripe prices. The ids are stored on
// organizations.plan_tier, in Stripe session metadata, in referral grants and
// in a thousand call sites; renaming them would have been a migration with
// nothing to gain. Every superseded price stays in legacy_price_ids and keeps
// resolving.
//
// Enterprise left the public catalog with this change: "everything unlocked"
// is now the self-hosted install, and the definition stays for any org that
// holds it.
const PUBLIC_BILLING_PLAN_IDS = ['free', 'developer_basic', 'developer_pro'];
// pilot is internal/trial only; governance tiers removed from self-serve checkout.
// lifetime cut from the lineup 2026-06-11 — definition kept inert for any
// existing lifetime orgs, but it is no longer purchasable.
// A plan listed here must have its Stripe price env vars set on the API, or
// validateCheckoutCatalog throws "Missing Stripe base price" (a 503
// billing_unavailable) for it: Individual needs STRIPE_PRICE_DEVELOPER_BASIC,
// Team needs STRIPE_PRICE_DEVELOPER_PRO.
const SELF_SERVE_PLAN_IDS = ['developer_basic', 'developer_pro'];

// --- New hosted signups: Free, or choose a plan first ------------------------
//
// HOSTED_FREE_TIER_FOR_NEW_SIGNUPS (default true, today's behaviour). Read at
// call time, never cached, so a test or an operator flipping it needs no
// restart of anything but the process that reads the environment.
//
// When it is false, a NEW account is created with no usable plan: plan_tier
// 'free' (so nothing anywhere reads it as paid) and subscription_status
// PLAN_REQUIRED_STATUS, which checkEnforcement refuses with error
// 'plan_required' and the dashboard answers by sending the person to
// /select-plan, where the Free option is not offered. Checkout replaces the
// status: the Stripe webhook writes the subscription's own status when it
// records the purchase.
//
// GRANDFATHERING IS BY CONSTRUCTION. Only the code that CREATES a brand-new
// account reads this switch. No existing row is rewritten when it flips, so an
// account created while it was true keeps its Free entitlements after it is
// turned off, and turning it back on changes nothing for an account created
// while it was off (that account still has to choose a plan).
//
// Note the cost before flipping it: nearly every real signup arrives through
// the ChatGPT connector's consent screen and never sees the dashboard, so with
// the switch off those people meet a refusal inside their AI tool, not a plan
// picker. The refusal names the page to visit (plan_url), but that is the wall.
const PLAN_REQUIRED_STATUS = 'plan_required';
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

function hostedFreeTierForNewSignups(env = process.env) {
  const raw = env.HOSTED_FREE_TIER_FOR_NEW_SIGNUPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !FALSE_WORDS.has(String(raw).trim().toLowerCase());
}

/**
 * The plan columns for an organizations row created for a brand-new account.
 *
 * `freeStatus` is what that creation site wrote before this switch existed
 * ('trial_active' everywhere today), so with the switch on nothing changes.
 */
function newSignupPlanState({ freeStatus = 'trial_active', env = process.env } = {}) {
  return {
    plan: 'free',
    plan_tier: 'free',
    subscription_status: hostedFreeTierForNewSignups(env) ? freeStatus : PLAN_REQUIRED_STATUS,
  };
}

const PLAN_ALIASES = {
  standard: 'starter',
  starter_cx: 'starter',
  growth_cx: 'growth',
  scale_cx: 'scale',
  refund_gate_pilot: 'pilot',
  personal_basic: 'developer_basic',
  personal_developer: 'developer_pro',
  pro: 'enterprise',
  ltd: 'lifetime',
};

const CANONICAL_PLAN_ORDER = {
  free: 0,
  developer_basic: 1,
  developer_pro: 2,
  lifetime: 3,
  starter: 1,
  growth: 2,
  scale: 3,
  enterprise: 4,
  pilot: 5,
};

function normalizePlanId(planId) {
  if (!planId || typeof planId !== 'string') return 'free';
  const normalized = planId.trim();
  return PLAN_ALIASES[normalized] || normalized;
}

function createStripePrices({
  monthly = null,
  annual = null,
  overageMonthly = null,
  overageAnnual = null,
} = {}) {
  return {
    monthly,
    annual,
    overage_monthly: overageMonthly,
    overage_annual: overageAnnual,
  };
}

const PLANS = {
  free: {
    id: 'free',
    publicName: 'Free',
    price: 0,
    annual_price: 0,
    public: true,
    is_trial: true,
    account_type: 'organization',
    stripe_prices: createStripePrices(),
    stripe_price_id: null,
    legacy_price_ids: [],
    rate_limit: 100,
    limits: {
      // null = no volume cap. Free is gated on SCOPE — everything within a project
      // is free, everything across projects is Pro — plus a 90-day memory window.
      // It is NOT gated on sync/decision volume: never throttle the daily habit
      // we're trying to build. checkEnforcement treats a null included_decisions
      // as uncapped (Number.isFinite guard) and the dashboard renders it as
      // "unlimited". Note this is distinct from TRIAL_DECISION_LIMIT, its own constant.
      included_decisions: null,
      // Same null sentinel, for the same reason: the tool-count cap was never
      // enforced anywhere in the codebase and no user-facing surface has ever
      // sold a number (select-plan says "All integrations"), so the config was
      // simply untrue. It stays uncapped deliberately — connecting a SECOND
      // tool is the habit signal the product lives on (second_tool_connected),
      // and a cap here would gate exactly the behaviour we want more of.
      included_integrations: null,
      included_admins: 1,
      audit_retention_days: 1,
      // The workspace cap is GONE (2026-08-27). It sat directly on top of the moat:
      // a capped free user only ever experiences per-project memory, which is the
      // commoditized half, and can never reach the cross-project state Pro sells.
      // Project four is where cross-project stops being a feature and becomes a
      // need, and nobody could reach project four. null = uncapped; createProject's
      // Number.isFinite guard skips the gate entirely.
      included_projects: null,
      // 90 days, up from 7. The window is the safety valve, not the gate — it has
      // to not bite in week one and to grow teeth only once the account is worth
      // something. applyHistoryWindow narrows the BRIEF, never storage.
      history_days: 90,
      // Same null sentinel for the (also uncapped) daily sync rate.
      syncs_per_day: null,
      // One seat. A team workspace is the paid unit, so the free tier is a
      // person rather than a group — but note this bounds the INVITE only, never
      // a brief, so nothing a free user already has can stop working.
      included_seats: 1,
      included_skills: 1,
    },
    features: {
      escalation_rules: false,
      human_approval: false,
      alerts_basic: false,
      alerts_advanced: false,
      audit_log: false,
      webhooks: false,
      fail_mode_config: false,
      team_management: false,
      auto_sync: false,
      api_access: false,
      context_sharing: false,
      advanced_analytics: false,
      shared_skills: false,
      // Cross-project surfaces. Free hits the SAME /portfolio endpoint and gets
      // its own real counts back — the contents are what's withheld. That locked
      // state is the entire upgrade mechanic, which is why unlimited free
      // projects pays for itself: every project a free user adds raises the
      // number they see locked.
      portfolio: false,
      // Public share links for a brief (/s/[token]).
      trail_share: false,
    },
  },
  starter: {
    id: 'starter',
    publicName: 'Starter',
    price: 299,
    annual_price: 2990,
    public: true,
    account_type: 'organization',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || process.env.STRIPE_PRICE_STARTER,
      annual: process.env.STRIPE_PRICE_STARTER_ANNUAL,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_STARTER_MONTHLY || process.env.STRIPE_PRICE_STARTER || null,
    // Both spellings of the monthly price: `A || B` above maps only one of them when
    // both are set, and the other would fall out of the price map (2026-11 sweep).
    legacy_price_ids: [process.env.STRIPE_PRICE_STANDARD_BASE, process.env.STRIPE_PRICE_STARTER_CX, process.env.STRIPE_PRICE_STARTER].filter(Boolean),
    rate_limit: 1000,
    limits: {
      included_decisions: 5000,
      included_integrations: 1,
      included_admins: 2,
      audit_retention_days: 14,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: false,
      alerts_advanced: false,
      audit_log: true,
      webhooks: false,
      fail_mode_config: false,
      team_management: true,
    },
  },
  growth: {
    id: 'growth',
    publicName: 'Growth',
    price: 999,
    annual_price: 9990,
    public: true,
    account_type: 'organization',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY || process.env.STRIPE_PRICE_GROWTH,
      annual: process.env.STRIPE_PRICE_GROWTH_ANNUAL,
      overageMonthly: process.env.STRIPE_PRICE_GROWTH_OVERRUN_MONTHLY,
      overageAnnual: process.env.STRIPE_PRICE_GROWTH_OVERRUN_ANNUAL,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_GROWTH_MONTHLY || process.env.STRIPE_PRICE_GROWTH || null,
    legacy_price_ids: [process.env.STRIPE_PRICE_GROWTH_BASE, process.env.STRIPE_PRICE_GROWTH_CX, process.env.STRIPE_PRICE_GROWTH].filter(Boolean),
    rate_limit: 5000,
    limits: {
      included_decisions: 25000,
      included_integrations: 3,
      included_admins: 5,
      audit_retention_days: 90,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: true,
      alerts_advanced: false,
      audit_log: true,
      webhooks: true,
      fail_mode_config: true,
      team_management: true,
    },
    overage_per_decision: 0.0005,
  },
  scale: {
    id: 'scale',
    publicName: 'Scale',
    price: 2500,
    annual_price: 25000,
    public: true,
    account_type: 'organization',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_SCALE_MONTHLY || process.env.STRIPE_PRICE_SCALE,
      annual: process.env.STRIPE_PRICE_SCALE_ANNUAL,
      overageMonthly: process.env.STRIPE_PRICE_SCALE_OVERRUN_MONTHLY,
      overageAnnual: process.env.STRIPE_PRICE_SCALE_OVERRUN_ANNUAL,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_SCALE_MONTHLY || process.env.STRIPE_PRICE_SCALE || null,
    legacy_price_ids: [process.env.STRIPE_PRICE_SCALE_CX, process.env.STRIPE_PRICE_SCALE].filter(Boolean),
    rate_limit: 10000,
    limits: {
      included_decisions: 100000,
      included_integrations: 10,
      included_admins: 999,
      audit_retention_days: 365,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: true,
      alerts_advanced: true,
      audit_log: true,
      webhooks: true,
      fail_mode_config: true,
      team_management: true,
    },
    overage_per_decision: 0.0003,
  },
  pilot: {
    id: 'pilot',
    publicName: 'Pilot',
    price: 499,
    annual_price: null,
    public: false,
    account_type: 'organization',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_PILOT,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_PILOT || null,
    legacy_price_ids: [process.env.STRIPE_PRICE_REFUND_GATE_PILOT].filter(Boolean),
    rate_limit: 1000,
    limits: {
      included_decisions: 50000,
      included_integrations: 1,
      included_admins: 2,
      audit_retention_days: 30,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: true,
      alerts_advanced: false,
      audit_log: true,
      webhooks: false,
      fail_mode_config: false,
      team_management: true,
    },
    auto_roll_to: 'growth',
  },
  enterprise: {
    id: 'enterprise',
    publicName: 'Enterprise',
    price: null,
    annual_price: null,
    public: true,
    account_type: 'organization',
    stripe_prices: createStripePrices(),
    stripe_price_id: null,
    legacy_price_ids: [process.env.STRIPE_PRICE_PRO_BASE].filter(Boolean),
    rate_limit: 20000,
    limits: {
      included_decisions: 10000000,
      included_integrations: 999,
      included_admins: 999,
      audit_retention_days: 365,
      included_skills: null,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: true,
      alerts_advanced: true,
      audit_log: true,
      webhooks: true,
      fail_mode_config: true,
      team_management: true,
      shared_skills: true,
    },
  },
  developer_basic: {
    id: 'developer_basic',
    // Hosted Individual (2026-11): the whole single-person product. This is the
    // plan that was sold as "Pro", with the same entitlements, renamed. The id
    // stays developer_basic (see the header above); PLAN_ALIASES maps the word
    // `pro` to ENTERPRISE, so never hand-grant this plan by writing 'pro'.
    //
    // $12/mo and $96/yr are the prices of the EXISTING Stripe prices behind
    // STRIPE_PRICE_DEVELOPER_BASIC and STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL
    // (decided 2026-11: no new Stripe prices for the open-source move). The
    // displayed price must equal what those prices charge; change one and the
    // other, never one alone.
    publicName: 'Individual',
    price: 12,
    // $96/yr — $8/mo effective, $48 less than twelve months at $12. The catalog
    // needs an annual entry: every checkout surface defaults to the Annual
    // toggle and every annual figure on them is derived from this number.
    annual_price: 96,
    public: true,
    account_type: 'personal',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_DEVELOPER_BASIC,
      annual: process.env.STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_DEVELOPER_BASIC || null,
    // ⚠ SUPERSEDED PRICES MUST STAY LISTED, or existing subscribers break.
    //
    // webhooks-stripe.js builds priceId -> plan from exactly these env vars
    // (getAllPricePlanMappings). A price it cannot map grants nothing: a live
    // subscription on one keeps whatever plan the workspace already has, a new
    // purchase on one gets no plan at all, and the operator is alerted (once a
    // day per price) — see subscriptionState there. So when a price is
    // superseded, the OLD id drops out of the mapping unless it is listed here:
    // nobody still on it loses their plan any more, but every event for them
    // alerts and a seat change on it is not applied.
    //
    // Stripe prices are immutable, so a price change always means creating a
    // new one and leaving existing subscriptions on the old — the normal case,
    // not an edge case. The current $12/$96 prices are mapped through
    // stripe_prices above; every superseded price this plan was sold at is here:
    //   STRIPE_PRICE_DEVELOPER_BASIC_LEGACY  the $10/mo Pro price (before 2026-08-28)
    //   STRIPE_PRICE_PERSONAL_BASIC          the oldest personal-plan price
    // Leave those Fly secrets set for as long as anyone is subscribed on them.
    legacy_price_ids: [
      process.env.STRIPE_PRICE_PERSONAL_BASIC,
      process.env.STRIPE_PRICE_DEVELOPER_BASIC_LEGACY,
    ].filter(Boolean),
    rate_limit: 200,
    limits: {
      // Pro's promise is absolute: nothing on this plan runs out. null = uncapped
      // (checkEnforcement's Number.isFinite guard skips null caps; the project
      // and history gates use the same guard; the dashboard renders "unlimited").
      // Paying must never reintroduce a meter the free tier doesn't have — Free
      // is the bounded tier (90-day memory window; projects are uncapped on both
      // tiers as of 2026-08-27), Pro is permanence +
      // breadth. Abuse is handled by rate_limit, never by a visible quota.
      included_decisions: null,
      included_integrations: null,
      included_admins: 1,
      audit_retention_days: 90,
      included_projects: null,
      history_days: null,
      syncs_per_day: null,
      included_seats: 1,
      included_skills: null,
    },
    features: {
      escalation_rules: false,
      human_approval: false,
      alerts_basic: false,
      alerts_advanced: false,
      webhooks: false,
      audit_log: false,
      fail_mode_config: false,
      team_management: false,
      auto_sync: true,
      api_access: false,
      context_sharing: false,
      advanced_analytics: false,
      shared_skills: true,
      // The two cross-project surfaces Pro is sold on.
      portfolio: true,
      trail_share: true,
    },
  },
  developer_pro: {
    id: 'developer_pro',
    publicName: 'Team',
    // Hosted Team: $15 per seat, per month — the price the existing Stripe price
    // behind STRIPE_PRICE_DEVELOPER_PRO charges (per_unit, so quantity is the
    // seat count). Everything Individual has for each person, plus the team
    // workspace — membership, sharing, per-project privacy, attribution.
    price: 15,
    // $150/seat/year (STRIPE_PRICE_DEVELOPER_PRO_ANNUAL) — $12.50/mo effective,
    // $30 per seat less than twelve months at $15. Needed for the same reason
    // as Individual's: the pickers default to Annual.
    annual_price: 150,
    // 14 days free, card up front. Team is the one plan a buyer cannot evaluate
    // before paying: team_management is false on Free AND on Individual, so every
    // feature Team sells — the shared workspace, attribution, the audit log —
    // is invisible until after checkout. Plan DATA (like minimum_seats) rather
    // than a literal in stripeService: the checkout, the webhook and the pricing
    // copy all read the same number from here. The card is still collected at
    // checkout (payment_method_collection: 'always'), so the trial converts by
    // default and "free" means deferred, not optional.
    trial_days: 14,
    public: true,
    // Organization, not personal: this plan's whole purpose is more than one
    // human sharing one workspace.
    account_type: 'organization',
    stripe_prices: createStripePrices({
      monthly: process.env.STRIPE_PRICE_DEVELOPER_PRO,
      annual: process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL,
    }),
    stripe_price_id: process.env.STRIPE_PRICE_DEVELOPER_PRO || null,
    // Every other id Team has been sold under, so nobody on one falls out of
    // the map (the current prices are mapped through stripe_prices above):
    //   STRIPE_PRICE_MAX_MONTHLY / STRIPE_PRICE_MAX_ANNUAL   the older spelling
    //   STRIPE_PRICE_PERSONAL_DEVELOPER                      the oldest
    legacy_price_ids: [
      process.env.STRIPE_PRICE_PERSONAL_DEVELOPER,
      process.env.STRIPE_PRICE_MAX_MONTHLY,
      process.env.STRIPE_PRICE_MAX_ANNUAL,
    ].filter(Boolean),
    rate_limit: 500,
    limits: {
      included_decisions: 100000,
      included_integrations: 999,
      included_admins: 1,
      audit_retention_days: 365,
      included_projects: null,
      history_days: null,
      syncs_per_day: null,
      // Seats a Team workspace may hold. Enforced ONLY where a member is added
      // (teams.js), never on a read: a workspace over its cap keeps briefing
      // everybody it already has. A paywall that throws inside somebody's agent
      // loop produces a broken loop and a bug report, never an upgrade.
      included_seats: 5,
      // TWO IS THE FLOOR, AND IT IS DATA RATHER THAN A CONSTANT IN THE CHECKOUT.
      //
      // A one-seat "Team" is an Individual subscription with extra steps: it
      // costs more ($15 against $12), and every feature it adds — a shared
      // workspace, attribution, presence, an audit log that names people —
      // describes something that needs a second person to mean anything.
      // Selling it would be selling a worse Individual.
      //
      // Kept on the plan so the checkout floor and Stripe's own quantity
      // stepper read the same number from one place; a literal in
      // stripeService would drift the first time a plan wanted a different one.
      minimum_seats: 2,
      included_skills: null,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: false,
      alerts_advanced: false,
      webhooks: false,
      // This plan is called Team and shipped with team management switched off.
      // Every /api/v1/teams route gates on checkFeature(org, 'team_management'),
      // and the only plans where it was true are the governance tiers that moved
      // to another repository — so buying Team unlocked no team routes at all,
      // and the routes that existed sat behind plans nobody could purchase.
      team_management: true,
      auto_sync: true,
      api_access: true,
      context_sharing: true,
      advanced_analytics: true,
      shared_skills: true,
      portfolio: true,
      trail_share: true,
    },
  },
  lifetime: {
    id: 'lifetime',
    publicName: 'Lifetime',
    price: 250,
    annual_price: null,
    // Cut from self-serve 2026-06-11; kept inert for legacy lifetime orgs but no
    // longer advertised or purchasable (was a dead-end checkout that 500s).
    public: false,
    account_type: 'personal',
    stripe_prices: {
      monthly: process.env.STRIPE_PRICE_LIFETIME_250 || process.env.STRIPE_PRICE_LTD_250 || null,
      annual: null,
      overage_monthly: null,
      overage_annual: null,
    },
    stripe_price_id: process.env.STRIPE_PRICE_LIFETIME_250 || process.env.STRIPE_PRICE_LTD_250 || null,
    // Both spellings, so neither falls out of the price map when both are set.
    legacy_price_ids: [process.env.STRIPE_PRICE_LTD_250].filter(Boolean),
    rate_limit: 500,
    limits: {
      included_decisions: null,
      included_integrations: 999,
      included_admins: 2,
      audit_retention_days: null,
      included_projects: null,
      history_days: null,
      syncs_per_day: null,
      included_seats: 2,
    },
    features: {
      escalation_rules: true,
      human_approval: true,
      alerts_basic: false,
      alerts_advanced: false,
      webhooks: false,
      audit_log: true,
      fail_mode_config: false,
      team_management: true,
      auto_sync: true,
      api_access: true,
      context_sharing: true,
      advanced_analytics: true,
      // Legacy lifetime buyers paid for "everything"; new paid surfaces are
      // included rather than sold back to them.
      portfolio: true,
      trail_share: true,
    },
  },
};

function getPlan(planId) {
  return PLANS[normalizePlanId(planId)] || PLANS.free;
}

function getPlanOrder(planId) {
  return CANONICAL_PLAN_ORDER[normalizePlanId(planId)] ?? CANONICAL_PLAN_ORDER.free;
}

function isSelfServePlan(planId) {
  return SELF_SERVE_PLAN_IDS.includes(normalizePlanId(planId));
}

function isOrganizationPlan(planId) {
  return getPlan(planId).account_type === 'organization';
}

function isUnsupportedPersonalPlan(planId) {
  const plan = getPlan(planId);
  return plan.account_type === 'personal' && plan.supported === false;
}

function collectPriceIds(value, priceIds) {
  if (!value) return;
  if (typeof value === 'string') {
    priceIds.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPriceIds(item, priceIds);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectPriceIds(nested, priceIds);
  }
}

// Every environment variable the price map below is built from, by name, for
// the operator alert that names a price the map does not know
// (webhooks-stripe.js): the fix is always "set one of these". Pinned to the
// process.env reads in this file by tests/unit/stripe-webhook-unrecognised-price.test.js,
// so a new variable cannot be added above without appearing here.
const PRICE_MAP_ENV_VARS = Object.freeze([
  'STRIPE_PRICE_DEVELOPER_BASIC',
  'STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL',
  'STRIPE_PRICE_DEVELOPER_BASIC_LEGACY',
  'STRIPE_PRICE_PERSONAL_BASIC',
  'STRIPE_PRICE_MAX_MONTHLY',
  'STRIPE_PRICE_MAX_ANNUAL',
  'STRIPE_PRICE_DEVELOPER_PRO',
  'STRIPE_PRICE_DEVELOPER_PRO_ANNUAL',
  'STRIPE_PRICE_PERSONAL_DEVELOPER',
  'STRIPE_PRICE_LIFETIME_250',
  'STRIPE_PRICE_LTD_250',
  'STRIPE_PRICE_PRO_BASE',
  'STRIPE_PRICE_PILOT',
  'STRIPE_PRICE_REFUND_GATE_PILOT',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_STARTER_CX',
  'STRIPE_PRICE_STANDARD_BASE',
  'STRIPE_PRICE_GROWTH',
  'STRIPE_PRICE_GROWTH_MONTHLY',
  'STRIPE_PRICE_GROWTH_ANNUAL',
  'STRIPE_PRICE_GROWTH_BASE',
  'STRIPE_PRICE_GROWTH_CX',
  'STRIPE_PRICE_GROWTH_OVERRUN_MONTHLY',
  'STRIPE_PRICE_GROWTH_OVERRUN_ANNUAL',
  'STRIPE_PRICE_SCALE',
  'STRIPE_PRICE_SCALE_MONTHLY',
  'STRIPE_PRICE_SCALE_ANNUAL',
  'STRIPE_PRICE_SCALE_CX',
  'STRIPE_PRICE_SCALE_OVERRUN_MONTHLY',
  'STRIPE_PRICE_SCALE_OVERRUN_ANNUAL',
]);

function getAllPricePlanMappings() {
  const mappings = {};
  for (const plan of Object.values(PLANS)) {
    const priceIds = [];
    collectPriceIds(plan.stripe_prices, priceIds);
    collectPriceIds(plan.legacy_price_ids || [], priceIds);
    collectPriceIds(plan.stripe_price_id, priceIds);

    for (const priceId of priceIds.filter(Boolean)) {
      mappings[priceId] = plan.id;
    }
  }
  return mappings;
}

function serializePublicPlan(planId) {
  const plan = getPlan(planId);
  return {
    id: plan.id,
    publicName: plan.publicName,
    price: plan.price,
    annual_price: plan.annual_price ?? null,
    contact_sales: plan.id === 'enterprise',
    is_trial: Boolean(plan.is_trial),
    // Days of free trial the checkout grants (0 = none). Public so pricing
    // surfaces can say "14-day free trial" from the same number the checkout
    // actually applies, instead of retyping it.
    trial_days: Number(plan.trial_days) || 0,
    limits: plan.limits,
    features: plan.features,
    overage_per_decision: plan.overage_per_decision ?? null,
  };
}

function getPublicBillingPlans() {
  return PUBLIC_BILLING_PLAN_IDS
    .map(serializePublicPlan)
    .filter((plan) => PLANS[plan.id]?.public !== false);
}

module.exports = {
  PLANS,
  PLAN_ALIASES,
  PUBLIC_BILLING_PLAN_IDS,
  SELF_SERVE_PLAN_IDS,
  PLAN_REQUIRED_STATUS,
  hostedFreeTierForNewSignups,
  newSignupPlanState,
  TRIAL_DAYS,
  TRIAL_PLAN,
  TRIAL_DECISION_LIMIT,
  REFERRAL_REWARD_TIER,
  REFERRAL_REWARD_DAYS,
  REFERRAL_REWARDED_CAP,
  REFERRAL_SIGNUP_SOURCES,
  normalizePlanId,
  getPlan,
  getPlanOrder,
  isSelfServePlan,
  isOrganizationPlan,
  isUnsupportedPersonalPlan,
  getAllPricePlanMappings,
  PRICE_MAP_ENV_VARS,
  getPublicBillingPlans,
  serializePublicPlan,
};

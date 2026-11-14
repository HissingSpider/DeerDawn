/**
 * Hosted pricing, 2026-11: Individual $12/person/mo ($96/yr), Team $15/seat/mo
 * ($150/seat/yr) on the EXISTING Stripe prices, Free kept for every existing
 * account, and a switch for whether NEW signups get Free.
 *
 * Four properties, each of which fails silently if it breaks:
 *   1. The catalog says what John decided, and the self-serve/public lists sell
 *      only Individual and Team.
 *   2. Every Stripe price this product has EVER been sold at still resolves to a
 *      paid plan. webhooks-stripe.js grants nothing for a price it cannot map, so
 *      an old price falling out of the map is a paying subscriber losing their
 *      plan on the next webhook with nothing erroring.
 *   3. Checkout reads exactly the current prices (STRIPE_PRICE_DEVELOPER_BASIC[_ANNUAL],
 *      STRIPE_PRICE_DEVELOPER_PRO[_ANNUAL]) and never a superseded or alias
 *      one: the $10 legacy price and the MAX_* spelling are mapped, not sold.
 *   4. HOSTED_FREE_TIER_FOR_NEW_SIGNUPS defaults to today's behaviour, only ever
 *      affects the account being CREATED, and an account created while it was
 *      off cannot use the product until it chooses a plan.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLANS_PATH = require.resolve('../../src/config/plans');

// Every price env var the catalog has ever read. Cleared around each fresh load
// so a developer's shell (or another test file) cannot leak a value in.
const ALL_PRICE_VARS = [
  'STRIPE_PRICE_DEVELOPER_BASIC', 'STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL', 'STRIPE_PRICE_DEVELOPER_BASIC_LEGACY',
  'STRIPE_PRICE_PERSONAL_BASIC', 'STRIPE_PRICE_MAX_MONTHLY', 'STRIPE_PRICE_MAX_ANNUAL',
  'STRIPE_PRICE_DEVELOPER_PRO', 'STRIPE_PRICE_DEVELOPER_PRO_ANNUAL', 'STRIPE_PRICE_PERSONAL_DEVELOPER',
  'STRIPE_PRICE_LIFETIME_250', 'STRIPE_PRICE_LTD_250', 'STRIPE_PRICE_PRO_BASE',
  'STRIPE_PRICE_PILOT', 'STRIPE_PRICE_REFUND_GATE_PILOT',
  'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_PRICE_STARTER_ANNUAL', 'STRIPE_PRICE_STARTER_CX', 'STRIPE_PRICE_STANDARD_BASE',
  'STRIPE_PRICE_GROWTH', 'STRIPE_PRICE_GROWTH_MONTHLY', 'STRIPE_PRICE_GROWTH_ANNUAL', 'STRIPE_PRICE_GROWTH_BASE', 'STRIPE_PRICE_GROWTH_CX',
  'STRIPE_PRICE_SCALE', 'STRIPE_PRICE_SCALE_MONTHLY', 'STRIPE_PRICE_SCALE_ANNUAL', 'STRIPE_PRICE_SCALE_CX',
];

function freshPlans(env = {}) {
  const before = { ...process.env };
  for (const name of ALL_PRICE_VARS) delete process.env[name];
  Object.assign(process.env, env);
  delete require.cache[PLANS_PATH];
  try {
    return require('../../src/config/plans');
  } finally {
    process.env = before;
    delete require.cache[PLANS_PATH];
  }
}

test('the catalog: Individual $12 / $96 a year, Team $15 / $150 per seat a year', () => {
  const { getPlan } = freshPlans();
  const individual = getPlan('developer_basic');
  const team = getPlan('developer_pro');
  assert.strictEqual(individual.publicName, 'Individual');
  assert.strictEqual(individual.price, 12);
  assert.strictEqual(individual.annual_price, 96);
  assert.strictEqual(individual.account_type, 'personal');
  assert.strictEqual(team.publicName, 'Team');
  assert.strictEqual(team.price, 15);
  assert.strictEqual(team.annual_price, 150);
  assert.strictEqual(team.account_type, 'organization');
  assert.strictEqual(team.limits.minimum_seats, 2, 'a one-seat Team is a worse Individual');
});

test('only Individual and Team are sold, and the old plans are not listed anywhere public', () => {
  const { SELF_SERVE_PLAN_IDS, PUBLIC_BILLING_PLAN_IDS, getPublicBillingPlans, isSelfServePlan } = freshPlans();
  assert.deepStrictEqual([...SELF_SERVE_PLAN_IDS], ['developer_basic', 'developer_pro']);
  assert.deepStrictEqual([...PUBLIC_BILLING_PLAN_IDS], ['free', 'developer_basic', 'developer_pro']);
  const ids = getPublicBillingPlans().map((p) => p.id);
  assert.deepStrictEqual(ids, ['free', 'developer_basic', 'developer_pro']);
  for (const retired of ['starter', 'growth', 'scale', 'pilot', 'lifetime', 'enterprise']) {
    assert.strictEqual(isSelfServePlan(retired), false, `${retired} must not be self-serve`);
    assert.ok(!ids.includes(retired), `${retired} must not be in the public catalog`);
  }
});

test('the existing prices map to the plans and are what checkout reads', () => {
  const { getAllPricePlanMappings, getPlan } = freshPlans({
    STRIPE_PRICE_DEVELOPER_BASIC: 'price_ind_m',
    STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL: 'price_ind_y',
    STRIPE_PRICE_DEVELOPER_PRO: 'price_team_m',
    STRIPE_PRICE_DEVELOPER_PRO_ANNUAL: 'price_team_y',
  });
  const map = getAllPricePlanMappings();
  assert.strictEqual(map.price_ind_m, 'developer_basic');
  assert.strictEqual(map.price_ind_y, 'developer_basic');
  assert.strictEqual(map.price_team_m, 'developer_pro');
  assert.strictEqual(map.price_team_y, 'developer_pro');
  // And checkout reads exactly these.
  assert.strictEqual(getPlan('developer_basic').stripe_prices.monthly, 'price_ind_m');
  assert.strictEqual(getPlan('developer_basic').stripe_prices.annual, 'price_ind_y');
  assert.strictEqual(getPlan('developer_pro').stripe_prices.monthly, 'price_team_m');
  assert.strictEqual(getPlan('developer_pro').stripe_prices.annual, 'price_team_y');
});

test('EVERY old price id still resolves to the paid plan it was sold as — nobody is mapped to free', () => {
  const old = {
    // Pro, every price it was ever sold at -> Individual (same entitlements)
    STRIPE_PRICE_DEVELOPER_BASIC: ['price_pro_12', 'developer_basic'],
    STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL: ['price_pro_96', 'developer_basic'],
    STRIPE_PRICE_DEVELOPER_BASIC_LEGACY: ['price_pro_10', 'developer_basic'],
    STRIPE_PRICE_PERSONAL_BASIC: ['price_personal_basic', 'developer_basic'],
    // Team at $15/$150 and its older names -> Team
    STRIPE_PRICE_MAX_MONTHLY: ['price_max_m', 'developer_pro'],
    STRIPE_PRICE_MAX_ANNUAL: ['price_max_y', 'developer_pro'],
    STRIPE_PRICE_DEVELOPER_PRO: ['price_team_15', 'developer_pro'],
    STRIPE_PRICE_DEVELOPER_PRO_ANNUAL: ['price_team_150', 'developer_pro'],
    STRIPE_PRICE_PERSONAL_DEVELOPER: ['price_personal_dev', 'developer_pro'],
    // Retired plans keep resolving to themselves
    STRIPE_PRICE_LIFETIME_250: ['price_lifetime', 'lifetime'],
    STRIPE_PRICE_LTD_250: ['price_ltd', 'lifetime'],
    STRIPE_PRICE_PRO_BASE: ['price_pro_base', 'enterprise'],
    STRIPE_PRICE_PILOT: ['price_pilot', 'pilot'],
    STRIPE_PRICE_REFUND_GATE_PILOT: ['price_rg_pilot', 'pilot'],
    STRIPE_PRICE_STARTER_MONTHLY: ['price_starter_m', 'starter'],
    STRIPE_PRICE_STARTER: ['price_starter_plain', 'starter'],
    STRIPE_PRICE_GROWTH: ['price_growth_plain', 'growth'],
    STRIPE_PRICE_SCALE: ['price_scale_plain', 'scale'],
    STRIPE_PRICE_STARTER_ANNUAL: ['price_starter_y', 'starter'],
    STRIPE_PRICE_STANDARD_BASE: ['price_standard', 'starter'],
    STRIPE_PRICE_GROWTH_MONTHLY: ['price_growth_m', 'growth'],
    STRIPE_PRICE_GROWTH_CX: ['price_growth_cx', 'growth'],
    STRIPE_PRICE_SCALE_MONTHLY: ['price_scale_m', 'scale'],
    STRIPE_PRICE_SCALE_CX: ['price_scale_cx', 'scale'],
  };
  const env = Object.fromEntries(Object.entries(old).map(([k, [v]]) => [k, v]));
  const { getAllPricePlanMappings, PRICE_MAP_ENV_VARS } = freshPlans(env);
  const map = getAllPricePlanMappings();
  for (const [name, [priceId, planId]] of Object.entries(old)) {
    assert.strictEqual(map[priceId], planId, `${name} (${priceId}) must resolve to ${planId}, not fall out of the map`);
    assert.ok(PRICE_MAP_ENV_VARS.includes(name), `${name} must be named in PRICE_MAP_ENV_VARS for the operator alert`);
  }
});

test('checkout never sells a superseded or alias price, even when it is set', () => {
  const { getPlan } = freshPlans({
    STRIPE_PRICE_DEVELOPER_BASIC: 'price_pro_12',
    STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL: 'price_pro_96',
    STRIPE_PRICE_DEVELOPER_BASIC_LEGACY: 'price_pro_10',
    STRIPE_PRICE_PERSONAL_BASIC: 'price_personal_basic',
    STRIPE_PRICE_MAX_MONTHLY: 'price_max_m',
    STRIPE_PRICE_MAX_ANNUAL: 'price_max_y',
    STRIPE_PRICE_DEVELOPER_PRO: 'price_team_15',
    STRIPE_PRICE_DEVELOPER_PRO_ANNUAL: 'price_team_150',
    STRIPE_PRICE_PERSONAL_DEVELOPER: 'price_personal_dev',
  });
  const individual = getPlan('developer_basic');
  assert.strictEqual(individual.stripe_prices.monthly, 'price_pro_12');
  assert.strictEqual(individual.stripe_prices.annual, 'price_pro_96');
  assert.strictEqual(individual.stripe_price_id, 'price_pro_12');
  const team = getPlan('developer_pro');
  assert.strictEqual(team.stripe_prices.monthly, 'price_team_15', 'the MAX_* spelling must not take precedence');
  assert.strictEqual(team.stripe_prices.annual, 'price_team_150');
  assert.strictEqual(team.stripe_price_id, 'price_team_15');
});

test('with the current price vars unset, the plans have no checkout price (a 503, not an old price)', () => {
  const { getPlan } = freshPlans({
    STRIPE_PRICE_DEVELOPER_BASIC_LEGACY: 'price_pro_10',
    STRIPE_PRICE_MAX_MONTHLY: 'price_max_m',
  });
  for (const id of ['developer_basic', 'developer_pro']) {
    const plan = getPlan(id);
    assert.strictEqual(plan.stripe_prices.monthly || null, null, `${id} monthly must be unset, not a superseded price`);
    assert.strictEqual(plan.stripe_price_id, null, `${id} stripe_price_id must not be a superseded price`);
  }
});

test('Individual is the whole single-person product; Team is Individual plus the team features', () => {
  const { getPlan } = freshPlans();
  const free = getPlan('free');
  const individual = getPlan('developer_basic');
  const team = getPlan('developer_pro');
  // Everything Free withholds that one person can use, Individual has.
  for (const f of ['portfolio', 'trail_share', 'shared_skills', 'auto_sync']) {
    assert.strictEqual(free.features[f], false, `free withholds ${f}`);
    assert.strictEqual(individual.features[f], true, `Individual includes ${f}`);
  }
  assert.strictEqual(individual.limits.history_days, null, 'Individual history never ages out');
  assert.strictEqual(individual.limits.included_skills, null);
  assert.strictEqual(individual.limits.included_seats, 1);
  assert.strictEqual(individual.features.team_management, false, 'team features are Team');
  // Team: a superset of Individual's features, plus team management.
  for (const [f, on] of Object.entries(individual.features)) {
    if (on) assert.strictEqual(team.features[f], true, `Team must include Individual's ${f}`);
  }
  assert.strictEqual(team.features.team_management, true);
  assert.strictEqual(team.features.context_sharing, true);
  assert.strictEqual(team.limits.history_days, null);
});

test('Free keeps exactly today\'s entitlements (the grandfathered tier)', () => {
  const { getPlan } = freshPlans();
  const free = getPlan('free');
  assert.deepStrictEqual(free.limits, {
    included_decisions: null,
    included_integrations: null,
    included_admins: 1,
    audit_retention_days: 1,
    included_projects: null,
    history_days: 90,
    syncs_per_day: null,
    included_seats: 1,
    included_skills: 1,
  });
  assert.deepStrictEqual(free.features, {
    escalation_rules: false, human_approval: false, alerts_basic: false, alerts_advanced: false,
    audit_log: false, webhooks: false, fail_mode_config: false, team_management: false,
    auto_sync: false, api_access: false, context_sharing: false, advanced_analytics: false,
    shared_skills: false, portfolio: false, trail_share: false,
  });
  assert.strictEqual(free.price, 0);
});

test('HOSTED_FREE_TIER_FOR_NEW_SIGNUPS defaults to true (today\'s behaviour) and only an explicit false turns it off', () => {
  const { hostedFreeTierForNewSignups } = freshPlans();
  assert.strictEqual(hostedFreeTierForNewSignups({}), true, 'unset = free tier for new signups');
  assert.strictEqual(hostedFreeTierForNewSignups({ HOSTED_FREE_TIER_FOR_NEW_SIGNUPS: '' }), true);
  assert.strictEqual(hostedFreeTierForNewSignups({ HOSTED_FREE_TIER_FOR_NEW_SIGNUPS: 'true' }), true);
  assert.strictEqual(hostedFreeTierForNewSignups({ HOSTED_FREE_TIER_FOR_NEW_SIGNUPS: 'garbage' }), true, 'a typo must not wall off signups');
  for (const off of ['false', 'FALSE', '0', 'no', 'off', ' false ']) {
    assert.strictEqual(hostedFreeTierForNewSignups({ HOSTED_FREE_TIER_FOR_NEW_SIGNUPS: off }), false, `${JSON.stringify(off)} turns it off`);
  }
});

test('newSignupPlanState: Free with the switch on, plan_required with it off — never a paid tier', () => {
  const { newSignupPlanState, PLAN_REQUIRED_STATUS } = freshPlans();
  assert.strictEqual(PLAN_REQUIRED_STATUS, 'plan_required');
  assert.deepStrictEqual(newSignupPlanState({ env: {} }), { plan: 'free', plan_tier: 'free', subscription_status: 'trial_active' });
  assert.deepStrictEqual(
    newSignupPlanState({ env: { HOSTED_FREE_TIER_FOR_NEW_SIGNUPS: 'false' } }),
    { plan: 'free', plan_tier: 'free', subscription_status: 'plan_required' },
  );
  assert.strictEqual(newSignupPlanState({ freeStatus: 'active', env: {} }).subscription_status, 'active');
});

test('every brand-new-account creation site reads the switch', () => {
  const fs = require('node:fs');
  const src = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
  // The Clerk webhook, the JIT path (two sites: a fresh identity and an unused
  // pre-created row) and the local signup route. A site that hard-codes
  // 'trial_active' for a new account hands Free to a signup the switch says
  // must choose a plan.
  assert.match(src('routes/auth-webhooks.js'), /newSignupPlanState\(\)/);
  assert.strictEqual((src('middleware/auth.js').match(/newSignupPlanState\(\)/g) || []).length, 2);
  assert.match(src('routes/shared/auth.js'), /newSignupPlanState\(\)\.subscription_status/);
});

// --- Enforcement: grandfathering and the refusal ---------------------------

function loadEnforcement(orgRow) {
  const dbPath = require.resolve('../../src/config/db');
  const redisPath = require.resolve('../../src/config/redis');
  const enfPath = require.resolve('../../src/services/enforcementService');
  const saved = { db: require.cache[dbPath], redis: require.cache[redisPath] };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => ({ rows: [orgRow] }) } };
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { redis: { get: async () => null, setex: async () => 'OK' } } };
  delete require.cache[enfPath];
  const mod = require(enfPath);
  return {
    mod,
    restore() {
      delete require.cache[enfPath];
      if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
      if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
    },
  };
}

test('grandfathering: turning the switch off changes nothing for an existing Free account', async () => {
  const existing = { org_id: 'org-old', plan: 'free', plan_tier: 'free', subscription_status: 'trial_active' };
  const before = process.env.HOSTED_FREE_TIER_FOR_NEW_SIGNUPS;
  process.env.HOSTED_FREE_TIER_FOR_NEW_SIGNUPS = 'false';
  const { mod, restore } = loadEnforcement(existing);
  try {
    const verdict = await mod.checkEnforcement('org-old');
    assert.strictEqual(verdict.allowed, true, 'an account created while Free was on keeps using Free');
    const { getEntitlementsFromOrg } = require('../../src/services/entitlementService');
    const ent = getEntitlementsFromOrg(existing);
    assert.strictEqual(ent.tier, 'free');
    assert.strictEqual(ent.limits.history_days, 90);
  } finally {
    restore();
    if (before === undefined) delete process.env.HOSTED_FREE_TIER_FOR_NEW_SIGNUPS;
    else process.env.HOSTED_FREE_TIER_FOR_NEW_SIGNUPS = before;
  }
});

test('an account created with the switch off is refused with plan_required until it checks out', async () => {
  const { mod, restore } = loadEnforcement({ org_id: 'org-new', plan: 'free', plan_tier: 'free', subscription_status: 'plan_required' });
  try {
    const verdict = await mod.checkEnforcement('org-new');
    assert.strictEqual(verdict.allowed, false);
    assert.strictEqual(verdict.error, 'plan_required');
    assert.strictEqual(verdict.upgrade_required, true);
  } finally {
    restore();
  }
  // Once the webhook records the purchase it writes Stripe's own status, and
  // the same account passes.
  const paid = loadEnforcement({ org_id: 'org-new', plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active' });
  try {
    assert.strictEqual((await paid.mod.checkEnforcement('org-new')).allowed, true);
  } finally {
    paid.restore();
  }
});

test('the 403 for plan_required names the page to choose a plan on', async () => {
  const enforcePath = require.resolve('../../src/middleware/enforcePlan');
  const servicePath = require.resolve('../../src/services/enforcementService');
  const savedService = require.cache[servicePath];
  require.cache[servicePath] = {
    id: servicePath, filename: servicePath, loaded: true,
    exports: { checkEnforcement: async () => ({ allowed: false, error: 'plan_required', subscription_status: 'plan_required', upgrade_required: true }) },
  };
  delete require.cache[enforcePath];
  const before = process.env.DASHBOARD_URL;
  process.env.DASHBOARD_URL = 'https://app.example.test/';
  try {
    const { evaluatePlanEnforcement } = require(enforcePath);
    const deny = await evaluatePlanEnforcement({
      actor: { type: 'user', id: 'u1', org_id: 'org-new', workspace_key: 'org-new' },
      originalUrl: '/api/v1/context/projects',
      method: 'GET',
    });
    assert.strictEqual(deny.status, 403);
    assert.strictEqual(deny.body.error, 'plan_required');
    assert.strictEqual(deny.body.plan_url, 'https://app.example.test/select-plan');
    assert.match(deny.body.message, /select-plan/);
  } finally {
    delete require.cache[enforcePath];
    if (savedService) require.cache[servicePath] = savedService; else delete require.cache[servicePath];
    if (before === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = before;
  }
});

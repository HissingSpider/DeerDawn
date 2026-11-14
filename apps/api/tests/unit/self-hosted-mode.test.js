/**
 * SELF-HOSTED MODE (SELF_HOSTED=true).
 *
 * DeerDawn self-hosted has every feature for every workspace and none of the
 * hosted vendors. These pin the contract other parts of the open-source
 * release build against:
 *
 *   - entitlements: full features, no caps, whatever the org row says
 *   - enforcement: never refuses on billing grounds (the owner's own lockdown
 *     switch still applies)
 *   - billing routes: 404 billing_disabled, before auth, no Stripe call
 *   - telemetry: PostHog / ad conversions off unless TELEMETRY_ENABLED=true
 *   - env.js: boots in production with no vendor keys; hosted production is
 *     exactly as strict as before
 *   - SIGNUP_MODE: first account, then invitation-only
 *
 * No database: db and redis are replaced in the require cache.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');

const redisStore = new Map();
const mockRedis = {
  get: async (k) => redisStore.get(k) || null,
  setex: async (k, _t, v) => { redisStore.set(k, v); return 'OK'; },
  set: async (k, v) => { redisStore.set(k, v); return 'OK'; },
  del: async (k) => { redisStore.delete(k); return 1; },
  incr: async () => 1,
  expire: async () => 1,
  on: () => {},
  status: 'ready',
};
require.cache[require.resolve('../../src/config/redis')] = { exports: { redis: mockRedis } };

// One programmable fake for every query this file makes.
let dbHandler = () => ({ rows: [] });
const queries = [];
const mockDb = {
  query: async (text, params) => {
    queries.push(String(text));
    return dbHandler(String(text), params || []);
  },
  pool: { connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }) },
};
require.cache[require.resolve('../../src/config/db')] = { exports: mockDb };

const selfHosted = require('../../src/config/selfHosted');
const { getEntitlementsFromOrg, getEntitlements, checkFeature, checkLimit } = require('../../src/services/entitlementService');
const { checkEnforcement } = require('../../src/services/enforcementService');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const FREE_ORG = { org_id: 'org-a', plan: 'free', plan_tier: 'free', subscription_status: 'trial_active', is_locked: false };

test('entitlements: every feature on and every limit uncapped, whatever the org row says', () => withEnv({ SELF_HOSTED: 'true' }, async () => {
  for (const org of [FREE_ORG, { ...FREE_ORG, subscription_status: 'past_due', plan_tier: 'developer_pro' }, null]) {
    const ent = getEntitlementsFromOrg(org);
    assert.strictEqual(ent.features.team_management, true);
    assert.strictEqual(ent.features.shared_skills, true);
    assert.strictEqual(ent.features.portfolio, true);
    for (const [key, value] of Object.entries(ent.limits)) {
      assert.strictEqual(value, null, `${key} must be uncapped`);
    }
    assert.ok('included_seats' in ent.limits && 'history_days' in ent.limits && 'included_skills' in ent.limits);
  }
  // getEntitlements does not even need the org row.
  queries.length = 0;
  const ent = await getEntitlements('org-anything');
  assert.strictEqual(ent.features.team_management, true);
  assert.strictEqual(queries.length, 0);
  // The two gates the team routes call never refuse.
  await checkFeature('org-a', 'team_management');
  await checkLimit('org-a', 'included_seats', 500);
}));

test('entitlements: hosted mode is unchanged (a free org has no team feature)', () => withEnv({ SELF_HOSTED: undefined }, () => {
  const ent = getEntitlementsFromOrg(FREE_ORG);
  assert.strictEqual(ent.features.team_management, false);
  assert.strictEqual(ent.limits.included_seats, 1);
}));

test('enforcement never refuses on billing grounds when self-hosted', () => withEnv({ SELF_HOSTED: 'true' }, async () => {
  const rows = [
    { ...FREE_ORG, org_id: 'org-pastdue', plan_tier: 'developer_pro', subscription_status: 'past_due' },
    { ...FREE_ORG, org_id: 'org-incomplete', plan_tier: 'developer_basic', subscription_status: 'incomplete' },
    { ...FREE_ORG, org_id: 'org-cancelled', plan_tier: 'developer_pro', subscription_status: 'cancelled' },
    { ...FREE_ORG, org_id: 'org-starter', plan_tier: 'starter', subscription_status: 'active' },
  ];
  for (const row of rows) {
    redisStore.clear();
    dbHandler = (text) => (text.includes('FROM organizations') ? { rows: [row] } : { rows: [{ used: 10_000_000 }] });
    const result = await checkEnforcement(row.org_id, 'team_management');
    assert.strictEqual(result.allowed, true, `${row.org_id} was refused: ${result.error}`);
  }
  dbHandler = () => ({ rows: [] });
}));

test('enforcement still honours the owner\'s own lockdown switch when self-hosted', () => withEnv({ SELF_HOSTED: 'true' }, async () => {
  redisStore.clear();
  dbHandler = (text) => (text.includes('FROM organizations') ? { rows: [{ ...FREE_ORG, org_id: 'org-locked', is_locked: true }] } : { rows: [] });
  const result = await checkEnforcement('org-locked');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.error, 'lockdown_active');
  dbHandler = () => ({ rows: [] });
}));

test('enforcement: hosted mode still refuses a past_due paid workspace', () => withEnv({ SELF_HOSTED: undefined }, async () => {
  redisStore.clear();
  dbHandler = (text) => (text.includes('FROM organizations') ? { rows: [{ ...FREE_ORG, org_id: 'org-h', plan_tier: 'developer_pro', subscription_status: 'past_due' }] } : { rows: [] });
  const result = await checkEnforcement('org-h');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.error, 'subscription_inactive');
  dbHandler = () => ({ rows: [] });
}));

test('billing routes answer 404 billing_disabled when self-hosted, before auth', () => withEnv({ SELF_HOSTED: 'true' }, async () => {
  const app = express();
  app.use('/api/v1/billing', require('../../src/routes/shared/billing'));
  app.use('/api/v1/webhooks/stripe', require('../../src/routes/webhooks-stripe'));
  for (const [method, url] of [['get', '/api/v1/billing/plans'], ['post', '/api/v1/billing/checkout'], ['post', '/api/v1/billing/portal'], ['post', '/api/v1/webhooks/stripe']]) {
    const res = await request(app)[method](url).send({});
    assert.strictEqual(res.status, 404, `${method.toUpperCase()} ${url}`);
    assert.strictEqual(res.body.error, 'billing_disabled');
  }
}));

test('billing routes are untouched on hosted (they reach auth, which refuses an anonymous call)', () => withEnv({ SELF_HOSTED: undefined }, async () => {
  const app = express();
  app.use('/api/v1/billing', require('../../src/routes/shared/billing'));
  const res = await request(app).get('/api/v1/billing/plans');
  assert.notStrictEqual(res.body?.error, 'billing_disabled');
}));

test('telemetry: off by default when self-hosted, on only with TELEMETRY_ENABLED=true, unchanged on hosted', () => {
  withEnv({ SELF_HOSTED: 'true', TELEMETRY_ENABLED: undefined }, () => assert.strictEqual(selfHosted.isTelemetryEnabled(), false));
  withEnv({ SELF_HOSTED: 'true', TELEMETRY_ENABLED: 'true' }, () => assert.strictEqual(selfHosted.isTelemetryEnabled(), true));
  withEnv({ SELF_HOSTED: undefined, TELEMETRY_ENABLED: undefined }, () => assert.strictEqual(selfHosted.isTelemetryEnabled(), true));
});

test('telemetry: ad-conversion uploads are not configured on a self-host even with every credential set', () => {
  const creds = {
    REDDIT_PIXEL_ID: 'p', REDDIT_CONVERSIONS_ACCESS_TOKEN: 't',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's',
    GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_CUSTOMER_ID: '1', GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID: '2',
  };
  const reddit = require('../../src/services/reddit');
  const googleAds = require('../../src/services/googleAds');
  const redditCheck = reddit.isRedditConfigured || reddit._internal?.isRedditConfigured;
  const adsCheck = googleAds.isGoogleAdsConfigured || googleAds._internal?.isGoogleAdsConfigured;
  withEnv({ ...creds, SELF_HOSTED: 'true', TELEMETRY_ENABLED: undefined }, () => {
    if (redditCheck) assert.strictEqual(redditCheck(), false);
    if (adsCheck) assert.strictEqual(adsCheck(), false);
  });
  withEnv({ ...creds, SELF_HOSTED: undefined }, () => {
    if (redditCheck) assert.strictEqual(redditCheck(), true);
    if (adsCheck) assert.strictEqual(adsCheck(), true);
  });
});

test('telemetry: the PostHog mirror sends nothing on a self-host with a key set', () => withEnv({ SELF_HOSTED: 'true', POSTHOG_API_KEY: 'phc_test' }, () => {
  const Module = require('node:module');
  const resolved = require.resolve('posthog-node');
  const original = require.cache[resolved];
  let constructed = 0;
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { PostHog: class { constructor() { constructed += 1; } capture() {} } } };
  delete require.cache[require.resolve('../../src/services/posthog')];
  try {
    const posthog = require('../../src/services/posthog');
    posthog.captureProductEvent({ distinctId: 'u1', event: 'x' });
    assert.strictEqual(constructed, 0);
  } finally {
    if (original) require.cache[resolved] = original; else delete require.cache[resolved];
    delete require.cache[require.resolve('../../src/services/posthog')];
    void Module;
  }
}));

test('deployment info is what the dashboard reads', () => {
  withEnv({ SELF_HOSTED: 'true', TELEMETRY_ENABLED: undefined, SIGNUP_MODE: undefined, AUTH_PROVIDER: undefined, SOURCE_CODE_URL: undefined }, () => {
    assert.deepStrictEqual(selfHosted.deploymentInfo(), {
      self_hosted: true, billing_enabled: false, telemetry_enabled: false, signup_mode: 'invite_only', auth_provider: 'local',
      source_code_url: 'https://github.com/HissingSpider/DeerDawn',
    });
  });
  withEnv({ SELF_HOSTED: undefined, SIGNUP_MODE: undefined }, () => {
    const info = selfHosted.deploymentInfo();
    assert.strictEqual(info.self_hosted, false);
    assert.strictEqual(info.billing_enabled, true);
    assert.strictEqual(info.signup_mode, 'open');
  });
});

test('source_code_url (AGPL-3.0 section 13): upstream by default, the operator\'s fork when set, never a non-http link', () => {
  withEnv({ SOURCE_CODE_URL: undefined, SELF_HOSTED: 'true' }, () => {
    assert.strictEqual(selfHosted.deploymentInfo().source_code_url, 'https://github.com/HissingSpider/DeerDawn');
  });
  withEnv({ SOURCE_CODE_URL: undefined, SELF_HOSTED: undefined }, () => {
    // Hosted answers too: the hosted service runs this code and links to it.
    assert.strictEqual(selfHosted.deploymentInfo().source_code_url, selfHosted.DEFAULT_SOURCE_CODE_URL);
  });
  withEnv({ SOURCE_CODE_URL: '  https://git.example.com/acme/deerdawn-fork  ', SELF_HOSTED: 'true' }, () => {
    assert.strictEqual(selfHosted.deploymentInfo().source_code_url, 'https://git.example.com/acme/deerdawn-fork');
  });
  for (const bad of ['javascript:alert(1)', 'not a url', 'ftp://example.com/src', 'data:text/html,hi']) {
    withEnv({ SOURCE_CODE_URL: bad, SELF_HOSTED: 'true' }, () => {
      assert.strictEqual(selfHosted.sourceCodeUrl(), selfHosted.DEFAULT_SOURCE_CODE_URL, bad);
    });
  }
});

test('SIGNUP_MODE: default invite_only when self-hosted, open otherwise; a typo never opens it', () => {
  withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: undefined }, () => assert.strictEqual(selfHosted.signupMode(), 'invite_only'));
  withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: 'open' }, () => assert.strictEqual(selfHosted.signupMode(), 'open'));
  withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: 'opne' }, () => assert.strictEqual(selfHosted.signupMode(), 'invite_only'));
  withEnv({ SELF_HOSTED: undefined, SIGNUP_MODE: undefined }, () => assert.strictEqual(selfHosted.signupMode(), 'open'));
});

test('public URLs: PUBLIC_URL stands in on a self-host, never on hosted', () => {
  withEnv({ SELF_HOSTED: 'true', PUBLIC_URL: 'https://dd.example.com/', DASHBOARD_URL: undefined, API_BASE_URL: undefined, MARKETING_URL: undefined }, () => {
    assert.strictEqual(selfHosted.dashboardBaseUrl(), 'https://dd.example.com');
    assert.strictEqual(selfHosted.apiBaseUrl(), 'https://dd.example.com');
    assert.strictEqual(selfHosted.marketingBaseUrl(), 'https://dd.example.com');
  });
  withEnv({ SELF_HOSTED: undefined, PUBLIC_URL: 'https://evil.example', DASHBOARD_URL: undefined, API_BASE_URL: undefined, MARKETING_URL: undefined }, () => {
    assert.strictEqual(selfHosted.dashboardBaseUrl(), 'https://app.deerdawn.com');
    assert.strictEqual(selfHosted.apiBaseUrl(), 'https://api.deerdawn.com');
    assert.strictEqual(selfHosted.marketingBaseUrl(), 'https://deerdawn.com');
    assert.strictEqual(selfHosted.selfHostedPublicUrl(), '');
  });
});

test('boot log: one line per disabled vendor, nothing about Stripe being an error', () => withEnv({
  SELF_HOSTED: 'true', AUTH_PROVIDER: undefined, STRIPE_SECRET_KEY: undefined, POSTHOG_API_KEY: undefined, RESEND_API_KEY: undefined, FLY_ALLOC_ID: undefined, FLY_MACHINE_ID: undefined,
}, () => {
  const lines = selfHosted.describeVendors();
  for (const vendor of ['Clerk', 'Stripe', 'PostHog', 'Resend', 'Fly']) {
    assert.ok(lines.some((l) => l.includes(vendor)), `no line for ${vendor}`);
  }
  assert.ok(lines.every((l) => l.startsWith('[BOOT]')));
}));

// ── env.js boot, in a child process (it validates at require time) ──────────
const API_ROOT = path.resolve(__dirname, '..', '..');
const STRONG = crypto.randomBytes(32).toString('hex');

function boot(extraEnv) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  return spawnSync(process.execPath, ['-e', 'require(\'./src/config/env\'); console.log(\'BOOT_OK\')'], { cwd: API_ROOT, env, encoding: 'utf8' });
}

test('env.js: a self-host boots in production with only Postgres, a JWT secret and an LLM key', () => {
  const out = boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', DATABASE_URL: 'postgres://x/y', JWT_SECRET: STRONG, LLM_API_KEY: 'k' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /BOOT_OK/);
});

test('env.js: a self-host may run a keyless local model (LLM_API_URL not OpenAI)', () => {
  const out = boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', DATABASE_URL: 'postgres://x/y', JWT_SECRET: STRONG, LLM_API_URL: 'http://ollama:11434/v1' });
  assert.strictEqual(out.status, 0, out.stderr);
});

test('env.js: a self-host still refuses to boot without its own essentials', () => {
  assert.notStrictEqual(boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', JWT_SECRET: STRONG, LLM_API_KEY: 'k' }).status, 0, 'no DATABASE_URL');
  assert.notStrictEqual(boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', DATABASE_URL: 'postgres://x/y', JWT_SECRET: 'short', LLM_API_KEY: 'k' }).status, 0, 'weak JWT_SECRET');
  assert.notStrictEqual(boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', DATABASE_URL: 'postgres://x/y', JWT_SECRET: STRONG }).status, 0, 'no LLM');
  assert.notStrictEqual(boot({ NODE_ENV: 'production', SELF_HOSTED: 'true', DATABASE_URL: 'postgres://x/y', JWT_SECRET: STRONG, LLM_API_URL: 'https://api.openai.com/v1' }).status, 0, 'OpenAI URL with no key');
});

test('env.js: hosted production is exactly as strict as before (no SELF_HOSTED, no vendor keys)', () => {
  const out = boot({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://r', JWT_SECRET: STRONG, DEERDAWN_API_KEY: STRONG, DASHBOARD_URL: 'https://app' });
  assert.notStrictEqual(out.status, 0);
  assert.match(out.stderr, /STRIPE_SECRET_KEY is missing/);
});

test('env.js: hosted production still requires AUTH_PROVIDER=clerk with every key present', () => {
  const out = boot({
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://r', JWT_SECRET: STRONG, DEERDAWN_API_KEY: STRONG,
    DASHBOARD_URL: 'https://app', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', CLERK_SECRET_KEY: 'ck', CLERK_WEBHOOK_SECRET: 'cw',
    ENCRYPTION_MASTER_KEY: 'a'.repeat(32) + 'b'.repeat(32), OPENAI_API_KEY: 'o',
  });
  assert.notStrictEqual(out.status, 0);
  assert.match(out.stderr, /AUTH_PROVIDER must be set to clerk/);
  const ok = boot({
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://r', JWT_SECRET: STRONG, DEERDAWN_API_KEY: STRONG,
    DASHBOARD_URL: 'https://app', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', CLERK_SECRET_KEY: 'ck', CLERK_WEBHOOK_SECRET: 'cw',
    ENCRYPTION_MASTER_KEY: 'a'.repeat(32) + 'b'.repeat(32), OPENAI_API_KEY: 'o', AUTH_PROVIDER: 'clerk',
  });
  assert.strictEqual(ok.status, 0, ok.stderr);
});

// ── SIGNUP_MODE=invite_only on the real signup route ─────────────────────────
function signupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../../src/routes/shared/auth'));
  return app;
}

const INVITE_TOKEN = 'invite-token-abc';
const INVITE_HASH = crypto.createHash('sha256').update(INVITE_TOKEN).digest('hex');

function signupDb({ usersExist, inviteFor }) {
  return (text, params) => {
    if (text.includes('SELECT 1 FROM users LIMIT 1')) return { rows: usersExist ? [{ '?column?': 1 }] : [] };
    if (text.includes('FROM workspace_invites')) {
      return { rows: inviteFor && params[0] === INVITE_HASH && String(params[1]).toLowerCase() === inviteFor ? [{ invite_id: 'winv_1' }] : [] };
    }
    if (text.includes('SELECT * FROM users WHERE email')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
}

test('SIGNUP_MODE=invite_only: the first account on the install may sign up', () => withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: undefined, AUTH_PROVIDER: undefined }, async () => {
  dbHandler = signupDb({ usersExist: false });
  const res = await request(signupApp()).post('/api/v1/auth/signup').send({ email: 'owner@example.com', password: 'password123' });
  assert.notStrictEqual(res.status, 403, JSON.stringify(res.body));
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
}));

test('SIGNUP_MODE=invite_only: a later sign-up without an invitation is refused', () => withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: undefined, AUTH_PROVIDER: undefined }, async () => {
  dbHandler = signupDb({ usersExist: true, inviteFor: 'bob@example.com' });
  const none = await request(signupApp()).post('/api/v1/auth/signup').send({ email: 'eve@example.com', password: 'password123' });
  assert.strictEqual(none.status, 403);
  assert.strictEqual(none.body.error, 'signup_invite_required');
  // Somebody else's invitation token does not admit a different email.
  const wrongEmail = await request(signupApp()).post('/api/v1/auth/signup').send({ email: 'eve@example.com', password: 'password123', invite_token: INVITE_TOKEN });
  assert.strictEqual(wrongEmail.status, 403);
}));

test('SIGNUP_MODE=invite_only: the invited email with its token may sign up', () => withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: undefined, AUTH_PROVIDER: undefined }, async () => {
  dbHandler = signupDb({ usersExist: true, inviteFor: 'bob@example.com' });
  const res = await request(signupApp()).post('/api/v1/auth/signup').send({ email: 'Bob@example.com', password: 'password123', invite_token: INVITE_TOKEN });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
}));

test('SIGNUP_MODE=open on a self-host admits anybody', () => withEnv({ SELF_HOSTED: 'true', SIGNUP_MODE: 'open', AUTH_PROVIDER: undefined }, async () => {
  dbHandler = signupDb({ usersExist: true });
  const res = await request(signupApp()).post('/api/v1/auth/signup').send({ email: 'carol@example.com', password: 'password123' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  dbHandler = () => ({ rows: [] });
}));

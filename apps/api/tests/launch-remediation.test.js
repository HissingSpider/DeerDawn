const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Launch Remediation Regression Tests ===\n');

const orgsRoute = read('src/routes/shared/orgs.js');
const authMiddleware = read('src/middleware/auth.js');
const apiSchemas = read('src/schemas/index.js');
const authWebhooks = read('src/routes/auth-webhooks.js');
const autoMigrate = read('src/config/autoMigrate.js');
const schema = read('sql/schema.sql');
const plans = read('src/config/plans.js');
const dashboardApi = fs.readFileSync(
  path.resolve(root, '../dashboard/src/lib/api.ts'),
  'utf8'
);

test('team management routes should enforce team_management entitlement', () => {
  assert(
    orgsRoute.includes('team_management'),
    'team management routes do not enforce the team_management feature'
  );
});

test('auth middleware should default to a valid role', () => {
  assert(
    !authMiddleware.includes('|| \'member\''),
    'auth adapter still defaults to invalid role "member"'
  );
});

test('Clerk-authoritative production should reject local JWT fallback unless explicitly enabled', () => {
  assert(
    authMiddleware.includes('this.provider === \'clerk\' && !this.allowLocalFallback') &&
      authMiddleware.includes('return null;') &&
      authMiddleware.includes('return this._verifyLocal(token);'),
    'auth adapter does not fail closed before the optional local JWT fallback'
  );
});

test('Clerk tokens should use the backend SDK top-level verifier', () => {
  assert(
    authMiddleware.includes('verifyToken: verifyClerkToken') &&
      authMiddleware.includes('verifyClerkToken(token') &&
      !authMiddleware.includes('this.clerk.verifyToken(token'),
    'auth adapter still calls clerkClient.verifyToken, which is not available in the installed Clerk backend SDK'
  );
});

test('dashboard and onboarding keys should default to context read/write scopes', () => {
  assert(
    apiSchemas.includes('default([\'context:read\', \'context:write\'])') &&
      authWebhooks.includes('[\'context:read\', \'context:write\'], \'active\''),
    'new dashboard or onboarding keys still default to a non-context scope'
  );
});

test('system queries should use set_config instead of inline SET LOCAL', () => {
  assert(
    /set_config\([^)]*app\.current_org_id/.test(authMiddleware),
    'auth adapter still uses inline SET LOCAL org context'
  );
});

test('auto-migration should provision launch-critical schema objects', () => {
  for (const token of [
    'invite_code',
    'billing_cycle_anchor',
    'redaction_mode',
    'redaction_keys',
    'is_pilot',
    'pilot_ends_at',
    'is_locked',
    'shadow_mode',
    'fail_mode',
    'trial_ends_at',
    'account_type',
    'last_used_at',
    'expires_at',
    'access_logs',
    'system_health_log',
  ]) {
    assert(autoMigrate.includes(token), `auto-migration missing ${token}`);
  }
});

test('canonical schema should define launch-critical columns and tables', () => {
  for (const token of [
    'invite_code',
    'billing_cycle_anchor',
    'redaction_mode',
    'redaction_keys',
    'is_pilot',
    'pilot_ends_at',
    'is_locked',
    'shadow_mode',
    'fail_mode',
    'trial_ends_at',
    'account_type',
    'last_used_at',
    'expires_at',
    'CREATE TABLE IF NOT EXISTS access_logs',
    'CREATE TABLE IF NOT EXISTS system_health_log',
  ]) {
    assert(schema.includes(token), `schema missing ${token}`);
  }
});

test('self-serve plan list should expose starter, growth, and scale only', () => {
  assert(
    plans.includes('return SELF_SERVE_PLAN_IDS.includes(normalizePlanId(planId));') ||
    plans.includes('return SELF_SERVE_PLAN_IDS.includes(normalizePlanId(planId))'),
    'self-serve plan helper should route through the canonical starter/growth/scale list'
  );
});

test('dashboard API client should not reference removed local auth token helper', () => {
  assert(
    !dashboardApi.includes('setLocalAuthToken'),
    'dashboard API client still references removed setLocalAuthToken helper'
  );
});

if (process.exitCode) {
  console.error('\nLaunch remediation regressions detected.');
} else {
  console.log('\nLaunch remediation regressions cleared.');
}
